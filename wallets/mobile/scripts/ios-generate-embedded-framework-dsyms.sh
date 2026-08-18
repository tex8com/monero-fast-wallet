#!/bin/sh
set -eu

# React Native embeds these two prebuilt XCFrameworks without their dSYMs.
# During Archive, create UUID-matching dSYMs beside the app dSYM so that the
# archive contains a symbol bundle for every embedded executable.
if [ "${ACTION:-}" != "install" ]; then
  exit 0
fi

frameworks_directory="${TARGET_BUILD_DIR}/${FRAMEWORKS_FOLDER_PATH}"
symbols_directory="${DWARF_DSYM_FOLDER_PATH}"

for framework_name in ReactNativeDependencies hermesvm; do
  executable="${frameworks_directory}/${framework_name}.framework/${framework_name}"
  dsym="${symbols_directory}/${framework_name}.framework.dSYM"

  if [ ! -f "${executable}" ]; then
    continue
  fi

  rm -rf "${dsym}"
  mkdir -p "${symbols_directory}"
  /usr/bin/dsymutil "${executable}" -o "${dsym}" >/dev/null 2>&1
  /usr/bin/dwarfdump --uuid "${dsym}/Contents/Resources/DWARF/${framework_name}" >/dev/null
done
