#!/usr/bin/env bash
set -euo pipefail

repo_root="${SRCROOT}/../../.."
manifest_path="${repo_root}/config/v1-release-features.json"
generated_header="${DERIVED_FILE_DIR}/tex8_v1_release_features.h"
resource_root="${TARGET_BUILD_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}"
bundled_manifest="${resource_root}/v1-release-features.json"
asset_root="${MONERO_COMMUNITY_ASSET_ROOT:-}"

mkdir -p "${DERIVED_FILE_DIR}" "${resource_root}"

ruby -rjson -rfileutils -ruri -e '
  manifest_path, generated_header, bundled_manifest, resource_root, asset_root = ARGV
  raw = File.binread(manifest_path)
  manifest = JSON.parse(raw)
  unless manifest["schemaVersion"] == 1 && manifest["profile"] == "safe-wallet-v1"
    abort "error: Unsupported V1 release feature manifest"
  end
  enabled = manifest.dig("features", "moneroEnthusiastV1") == true
  config = manifest.dig("parameters", "moneroEnthusiastV1")

  https_root = lambda do |value|
    begin
      uri = URI(value)
      value.is_a?(String) && value.bytesize <= 200 &&
        uri.scheme == "https" && uri.host && !uri.userinfo &&
        (uri.path.empty? || uri.path == "/") && !uri.query && !uri.fragment
    rescue StandardError
      false
    end
  end
  safe_resource = lambda do |value|
    value.is_a?(String) && value.bytesize.between?(1, 256) &&
      !value.start_with?("/") &&
      value.split("/").none? { |part| part.empty? || part == ".." } &&
      value.match?(/\A[A-Za-z0-9._\/-]+\z/)
  end

  resources = []
  if enabled
    unless config.is_a?(Hash) &&
      https_root.call(config["apiOrigin"]) &&
      https_root.call(config["matrixHomeserver"]) &&
      https_root.call(config["catalogOrigin"]) &&
      https_root.call(config["advertisingOrigin"]) &&
      config["catalogScope"].is_a?(String) &&
      config["catalogScope"].match?(/\A[A-Za-z0-9_-]{1,128}\z/) &&
      config["catalogVerifyingKeyHex"].is_a?(String) &&
      config["catalogVerifyingKeyHex"].match?(/\A[0-9a-f]{64}\z/) &&
      config["advertisingVerifyingKeyHex"].is_a?(String) &&
      config["advertisingVerifyingKeyHex"].match?(/\A[0-9a-f]{64}\z/) &&
      config["advertisingCountry"].is_a?(String) &&
      config["advertisingCountry"].match?(/\A[A-Z]{2}\z/) &&
      config["artifactVerifyingKeyHex"].is_a?(String) &&
      config["artifactVerifyingKeyHex"].match?(/\A[0-9a-f]{64}\z/)
      abort "error: moneroEnthusiastV1 requires a complete pinned HTTPS release configuration"
    end
    resources = %w[
      artifactManifestResource
      pteResource
      tokenizerResource
      conformanceResource
    ].map { |key| config[key] }
    unless resources.all? { |resource| safe_resource.call(resource) }
      abort "error: Monero Enthusiast resource path is invalid"
    end
    unless asset_root && File.directory?(asset_root)
      abort "error: moneroEnthusiastV1 requires MONERO_COMMUNITY_ASSET_ROOT"
    end
  end

  header = <<~HEADER
    /*
     * Generated from config/v1-release-features.json.
     * Do not edit and do not use remote configuration for this switch.
     */
    #ifndef TEX8_V1_RELEASE_FEATURES_GENERATED_H
    #define TEX8_V1_RELEASE_FEATURES_GENERATED_H
    #define TEX8_MONERO_ENTHUSIAST_V1_ENABLED #{enabled ? 1 : 0}
    #endif
  HEADER
  File.binwrite(generated_header, header)
  FileUtils.cp(manifest_path, bundled_manifest)

  if enabled
    destination_root = File.join(resource_root, "CommunityV1")
    resources.each do |resource|
      source = File.join(asset_root, resource)
      metadata = File.lstat(source) rescue nil
      unless metadata&.file? && !metadata.symlink?
        abort "error: Missing regular Monero Enthusiast asset: #{resource}"
      end
      destination = File.join(destination_root, resource)
      FileUtils.mkdir_p(File.dirname(destination))
      FileUtils.cp(source, destination)
      File.chmod(0444, destination)
    end
  end
' "${manifest_path}" "${generated_header}" "${bundled_manifest}" \
  "${resource_root}" "${asset_root}"
