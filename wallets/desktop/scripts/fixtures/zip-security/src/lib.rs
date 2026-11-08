// SPDX-License-Identifier: MPL-2.0
// Each extraction target and sentinel belongs to this test's temporary tree.
#[cfg(all(test, unix))]
mod tests {
    use std::{fs, io::{Cursor, Write}, os::unix::fs::{symlink, PermissionsExt}, path::PathBuf};
    use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("mfw-zip-{}-{}", std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
            fs::create_dir(&path).unwrap();
            fs::create_dir(path.join("destination")).unwrap();
            fs::create_dir(path.join("outside")).unwrap();
            fs::write(path.join("outside/sentinel"), b"unchanged").unwrap();
            Self(path)
        }
        fn extract(&self, data: Vec<u8>) -> zip::result::ZipResult<()> {
            ZipArchive::new(Cursor::new(data))?.extract(self.0.join("destination"))
        }
        fn assert_sentinel_unchanged(&self) {
            assert_eq!(fs::read(self.0.join("outside/sentinel")).unwrap(), b"unchanged");
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    fn file_archive(name: &str) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer.start_file(name, SimpleFileOptions::default()).unwrap();
        writer.write_all(b"extracted").unwrap();
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn ordinary_files_extract_without_touching_other_paths() {
        let fixture = Fixture::new();
        fixture.extract(file_archive("file")).unwrap();
        assert_eq!(fs::read(fixture.0.join("destination/file")).unwrap(), b"extracted");
        fixture.assert_sentinel_unchanged();
    }

    #[test]
    fn archive_symlink_cannot_modify_a_file_outside_destination() {
        let fixture = Fixture::new();
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer.add_symlink("link", "../outside", SimpleFileOptions::default()).unwrap();
        writer.start_file("link/sentinel", SimpleFileOptions::default()).unwrap();
        writer.write_all(b"must not replace sentinel").unwrap();
        let _ = fixture.extract(writer.finish().unwrap().into_inner());
        fixture.assert_sentinel_unchanged();
    }

    #[test]
    fn existing_symlink_cannot_redirect_file_or_permission_changes() {
        let fixture = Fixture::new();
        let sentinel = fixture.0.join("outside/sentinel");
        fs::set_permissions(&sentinel, fs::Permissions::from_mode(0o640)).unwrap();
        symlink("../outside", fixture.0.join("destination/link")).unwrap();
        let _ = fixture.extract(file_archive("link/sentinel"));
        fixture.assert_sentinel_unchanged();
        assert_eq!(fs::metadata(&sentinel).unwrap().permissions().mode() & 0o7777, 0o640);
    }

    #[test]
    fn untrusted_unix_metadata_cannot_set_suid_or_sgid() {
        let fixture = Fixture::new();
        let mut data = file_archive("file");
        let central = data.windows(4).position(|part| part == b"PK\x01\x02").unwrap();
        data[central + 5] = 3; // Unix creator, as read from an archive.
        data[central + 38..central + 42].copy_from_slice(&((0o106755u32) << 16).to_le_bytes());
        fixture.extract(data).unwrap();
        assert_eq!(fs::metadata(fixture.0.join("destination/file")).unwrap().permissions().mode() & 0o6000, 0);
        fixture.assert_sentinel_unchanged();
    }
}
