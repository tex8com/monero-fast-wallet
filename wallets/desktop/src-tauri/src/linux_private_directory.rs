//! Private Linux storage checked without changing another owner's paths.

use std::{
    fs::{self, DirBuilder, File, Metadata, Permissions},
    io,
    os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt},
    path::{Component, Path},
};

unsafe extern "C" {
    fn geteuid() -> u32;
}

pub(crate) fn prepare_tor_directories(directory: &Path) -> io::Result<()> {
    ensure_private_directory(directory)?;
    ensure_private_directory(&directory.join("state"))?;
    ensure_private_directory(&directory.join("cache"))
}

pub(crate) fn ensure_private_directory(directory: &Path) -> io::Result<()> {
    // Linux uid_t is u32; this call has no preconditions or side effects.
    ensure_owned_private_directory(directory, unsafe { geteuid() })
}

fn reject_symlink_components(directory: &Path) -> io::Result<()> {
    if !directory.is_absolute()
        || directory.parent().is_none()
        || directory
            .components()
            .any(|part| part == Component::ParentDir)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Private directory must be an absolute non-root path",
        ));
    }
    let mut current = std::path::PathBuf::new();
    for component in directory.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "Private directory path contains a symlink or non-directory",
                ));
            }
            Ok(_) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn checked_owner(metadata: &Metadata, owner: u32) -> io::Result<()> {
    if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata.uid() != owner {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Private directory is not owned by the current user",
        ));
    }
    Ok(())
}

fn same_directory(left: &Metadata, right: &Metadata) -> bool {
    left.dev() == right.dev() && left.ino() == right.ino()
}

fn ensure_owned_private_directory(directory: &Path, owner: u32) -> io::Result<()> {
    reject_symlink_components(directory)?;
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(directory)?;
    let before = fs::symlink_metadata(directory)?;
    checked_owner(&before, owner)?;
    let handle = File::open(directory)?;
    let opened = handle.metadata()?;
    checked_owner(&opened, owner)?;
    reject_symlink_components(directory)?;
    let current = fs::symlink_metadata(directory)?;
    checked_owner(&current, owner)?;
    if !same_directory(&before, &opened) || !same_directory(&opened, &current) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Private directory changed during its ownership check",
        ));
    }
    // Apply permissions to the verified directory descriptor, never through
    // a path that could have been replaced by a symlink after the checks.
    handle.set_permissions(Permissions::from_mode(0o700))?;
    let final_path = fs::symlink_metadata(directory)?;
    checked_owner(&final_path, owner)?;
    if !same_directory(&opened, &final_path) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Private directory changed during its permission update",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::unix::fs::symlink,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };

    struct TemporaryDirectory(PathBuf);
    impl TemporaryDirectory {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "mfw-private-dir-{}-{stamp}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TemporaryDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn existing_group_writable_tor_directories_become_private_without_losing_state() {
        let root = TemporaryDirectory::new();
        for path in [&root.0, &root.0.join("state"), &root.0.join("cache")] {
            fs::create_dir_all(path).unwrap();
            fs::set_permissions(path, Permissions::from_mode(0o775)).unwrap();
        }
        fs::write(root.0.join("state/existing"), b"retained state").unwrap();
        prepare_tor_directories(&root.0).unwrap();
        prepare_tor_directories(&root.0).unwrap();
        for path in [&root.0, &root.0.join("state"), &root.0.join("cache")] {
            assert_eq!(fs::metadata(path).unwrap().mode() & 0o777, 0o700);
        }
        assert_eq!(
            fs::read(root.0.join("state/existing")).unwrap(),
            b"retained state"
        );
    }

    #[test]
    fn missing_tor_directories_are_created_private() {
        let root = TemporaryDirectory::new();
        let tor = root.0.join("new/tor");
        prepare_tor_directories(&tor).unwrap();
        for path in [&tor, &tor.join("state"), &tor.join("cache")] {
            assert_eq!(fs::metadata(path).unwrap().mode() & 0o777, 0o700);
        }
    }

    #[test]
    fn symlink_target_is_preserved_without_permission_changes() {
        let root = TemporaryDirectory::new();
        let target = root.0.join("target");
        fs::create_dir(&target).unwrap();
        fs::set_permissions(&target, Permissions::from_mode(0o755)).unwrap();
        let link = root.0.join("link");
        symlink(&target, &link).unwrap();
        assert!(ensure_private_directory(&link).is_err());
        assert_eq!(fs::metadata(target).unwrap().mode() & 0o777, 0o755);
        assert!(fs::symlink_metadata(link).unwrap().file_type().is_symlink());
    }

    #[test]
    fn ancestor_symlink_is_rejected_before_creating_a_child() {
        let root = TemporaryDirectory::new();
        let target = root.0.join("target");
        fs::create_dir(&target).unwrap();
        symlink(&target, root.0.join("alias")).unwrap();
        assert!(ensure_private_directory(&root.0.join("alias/new")).is_err());
        assert!(!target.join("new").exists());
    }

    #[test]
    fn different_owner_is_rejected_without_chown_or_chmod() {
        let root = TemporaryDirectory::new();
        fs::set_permissions(&root.0, Permissions::from_mode(0o775)).unwrap();
        let owner = fs::metadata(&root.0).unwrap().uid();
        assert!(ensure_owned_private_directory(&root.0, owner.wrapping_add(1)).is_err());
        let after = fs::metadata(&root.0).unwrap();
        assert_eq!(after.uid(), owner);
        assert_eq!(after.mode() & 0o777, 0o775);
    }

    #[test]
    fn ordinary_file_and_parent_traversal_are_rejected() {
        let root = TemporaryDirectory::new();
        let file = root.0.join("file");
        fs::write(&file, b"unchanged").unwrap();
        assert!(ensure_private_directory(&file).is_err());
        assert!(ensure_private_directory(&root.0.join("child/../other")).is_err());
        assert_eq!(fs::read(file).unwrap(), b"unchanged");
    }
}
