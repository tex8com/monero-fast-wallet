#!/usr/bin/env python3
"""Bundle external dylibs before signing; fail closed on a nonlocal LD closure."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess

MACHO = {bytes.fromhex(x) for x in ("feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca")}
SYSTEM = ("/System/Library/", "/usr/lib/")


def system(value):
    return value.startswith("/") and os.path.normpath(value).startswith(SYSTEM)


def version(value):
    return tuple(int(part) for part in value.split(".")) + (0,) * (3 - len(value.split(".")))


def min_versions(path):
    result, command = [], None
    for line in run("otool", "-l", str(path)).splitlines():
        field = line.strip()
        if field.startswith("cmd "):
            command = field[4:]
        elif command == "LC_BUILD_VERSION" and field.startswith("minos "):
            result.append(field[6:])
        elif command == "LC_VERSION_MIN_MACOSX" and field.startswith("version "):
            result.append(field[8:])
    return result


def run(*args):
    return subprocess.check_output(args, text=True, stderr=subprocess.STDOUT)


def within(path, parent):
    return path.resolve().is_relative_to(parent.resolve())


def macho(path):
    with path.open("rb") as stream:
        return stream.read(4) in MACHO


def image_info(path):
    loads, ids, rpaths = [], [], []
    command = None
    for line in run("otool", "-l", str(path)).splitlines():
        field = line.strip()
        if field.startswith("cmd "):
            command = field[4:]
        elif command == "LC_RPATH" and field.startswith("path "):
            rpaths.append(field[5:].rsplit(" (offset ", 1)[0])
        elif field.startswith("name "):
            value = field[5:].rsplit(" (offset ", 1)[0]
            if command == "LC_ID_DYLIB":
                ids.append(value)
            elif command in {"LC_LOAD_DYLIB", "LC_LOAD_WEAK_DYLIB", "LC_REEXPORT_DYLIB", "LC_LOAD_UPWARD_DYLIB", "LC_LAZY_LOAD_DYLIB"}:
                loads.append(value)
    return tuple(dict.fromkeys(loads)), tuple(dict.fromkeys(ids)), tuple(dict.fromkeys(rpaths))


def expand(value, origin, executable):
    if value == "@loader_path" or value.startswith("@loader_path/"):
        return origin.parent / value[len("@loader_path"):].lstrip("/")
    if value == "@executable_path" or value.startswith("@executable_path/"):
        return executable.parent / value[len("@executable_path"):].lstrip("/")
    if value.startswith("/"):
        return Path(value)
    raise ValueError(f"Unsupported load path {value!r} in {origin}")


class Bundle:
    def __init__(self, app, library_roots, overrides=None):
        import plistlib
        self.app = app.resolve()
        self.frameworks = self.app / "Contents/Frameworks"
        info = plistlib.loads((self.app / "Contents/Info.plist").read_bytes())
        self.executable = self.app / "Contents/MacOS" / info["CFBundleExecutable"]
        self.roots = [root.resolve() for root in library_roots]
        self.overrides = {path.name: path.resolve() for path in (overrides or [])}
        self.minimum = info.get("LSMinimumSystemVersion")
        if not isinstance(self.minimum, str) or not 1 <= len(self.minimum.split(".")) <= 3 or not all(part.isdigit() for part in self.minimum.split(".")):
            raise ValueError("The app must declare a valid LSMinimumSystemVersion")
        self.copied = []
        self.changed = []
        self.arches = {}

    def images(self):
        result = set()
        for path in (self.app / "Contents").rglob("*"):
            if path.is_file() and macho(path):
                if not within(path, self.app):
                    raise ValueError(f"Mach-O symlink escapes the bundle: {path}")
                result.add(path.resolve())
        return sorted(result)

    def resolve(self, load, origin, rpaths):
        if load.startswith("@rpath/"):
            suffix = load[len("@rpath/"):]
            main_paths = image_info(self.executable)[2]
            choices = [expand(value, origin, self.executable) / suffix for value in rpaths]
            choices += [expand(value, self.executable, self.executable) / suffix for value in main_paths]
        else:
            choices = [expand(load, origin, self.executable)]
        for choice in choices:
            if choice.is_file():
                return choice.resolve()
        raise ValueError(f"Unresolved dependency {load!r} in {origin}")

    def compatible(self, consumer, dependency):
        for image in (consumer, dependency):
            if image not in self.arches:
                self.arches[image] = set(run("lipo", "-archs", str(image)).split())
        if not self.arches[consumer] <= self.arches[dependency]:
            raise ValueError(f"Missing architectures in {dependency}, required by {consumer}")

    def check(self):
        images = self.images()
        edges = 0
        for image in images:
            loads, ids, rpaths = image_info(image)
            requirements = min_versions(image)
            architectures = set(run("lipo", "-archs", str(image)).split())
            if not architectures or len(requirements) != len(architectures):
                raise ValueError(f"Missing minimum macOS metadata for an architecture in {image}")
            for required in requirements:
                if version(required) > version(self.minimum):
                    raise ValueError(f"{image} requires macOS {required}; app declares {self.minimum}")
            for value in rpaths:
                path = expand(value, image, self.executable)
                if not within(path, self.app) and not system(str(path)):
                    raise ValueError(f"External non-system LC_RPATH {value!r} in {image}")
            for value in ids:
                if value.startswith("/"):
                    raise ValueError(f"Absolute install ID {value!r} in {image}")
            for load in loads:
                if system(load):
                    continue
                if load.startswith("/"):
                    raise ValueError(f"Absolute non-system dependency {load!r} in {image}")
                dependency = self.resolve(load, image, rpaths)
                if not within(dependency, self.app):
                    raise ValueError(f"Dependency escapes the bundle: {load!r} in {image}")
                if not macho(dependency):
                    raise ValueError(f"Dependency is not Mach-O: {dependency}")
                self.compatible(image, dependency)
                edges += 1
        return {"machOImages": len(images), "localDependencyEdges": edges, "closureVerified": True, "minimumSystemVersion": self.minimum, "deploymentTargetsVerified": True}

    def bundle(self):
        queue = [(image, image) for image in self.images()]
        origins, done, origin_by_image = {}, set(), {}
        while queue:
            image, origin = queue.pop(0)
            origin = origin_by_image.get(image, origin)
            if image in done:
                continue
            done.add(image)
            loads, ids, rpaths = image_info(image)
            for load in loads:
                if system(load):
                    continue
                source = self.resolve(load, origin, rpaths)
                dependency_name = Path(load).name
                override = self.overrides.get(dependency_name)
                if override is not None:
                    source = override
                self.compatible(image, source)
                if within(source, self.app):
                    destination = source
                else:
                    if source.suffix != ".dylib" or not (source in self.overrides.values() or any(within(source, root) for root in self.roots)):
                        raise ValueError(f"External dependency is outside the allowed dylib roots: {source}")
                    if source not in origins:
                        self.frameworks.mkdir(parents=True, exist_ok=True)
                        destination = self.frameworks / dependency_name
                        if destination.exists() and destination.read_bytes() != source.read_bytes() and source not in self.overrides.values():
                            raise ValueError(f"Dylib basename collision: {source} versus {destination}")
                        if not destination.exists() or source in self.overrides.values():
                            shutil.copy2(source, destination)
                        destination.chmod(destination.stat().st_mode | 0o200)
                        origins[source] = destination
                        origin_by_image[destination] = source
                        done.discard(destination)
                        self.arches.pop(destination, None)
                        queue.append((destination, source))
                        self.copied.append({"source": str(source), "destination": str(destination.relative_to(self.app))})
                    destination = origins[source]
                # Direct local references avoid dependence on the build host's
                # rpath order; a dylib resolves siblings relative to its loader.
                anchor = "@executable_path" if image.parent == self.executable.parent else "@loader_path"
                local = anchor + "/" + os.path.relpath(destination, image.parent)
                if load != local:
                    run("install_name_tool", "-change", load, local, str(image))
                    self.changed.append({"image": str(image.relative_to(self.app)), "old": load, "new": local})
            if ids:
                local_id = "@rpath/" + image.name
                if any(value != local_id for value in ids):
                    run("install_name_tool", "-id", local_id, str(image))
            for value in rpaths:
                path = expand(value, origin, self.executable)
                if not within(path, self.app) and not system(str(path)):
                    run("install_name_tool", "-delete_rpath", value, str(image))
        return self.check()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", type=Path)
    parser.add_argument("--check", action="store_true", help="Read-only closure validation")
    parser.add_argument("--library-root", type=Path, action="append", default=[], help="Additional explicit external dylib root")
    parser.add_argument("--dylib-override", type=Path, action="append", default=[], help="Explicit verified replacement dylib (same basename)")
    args = parser.parse_args()
    bundle = Bundle(args.app, [Path("/opt/homebrew"), Path("/usr/local"), *args.library_root], args.dylib_override)
    result = bundle.check() if args.check else bundle.bundle()
    print(json.dumps({**result, "copied": bundle.copied, "changed": bundle.changed}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(f"macOS dependency closure failed: {error}") from error
