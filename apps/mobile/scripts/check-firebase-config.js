const fs = require("fs");
const path = require("path");

const expectedPackage = "com.tex8.monerowallet";
const androidPath = path.join(__dirname, "..", "android", "app", "google-services.json");
const iosPath = path.join(__dirname, "..", "ios", "GoogleService-Info.plist");
const errors = [];

if (!fs.existsSync(androidPath)) {
  errors.push(`Missing ${androidPath}`);
} else {
  const config = JSON.parse(fs.readFileSync(androidPath, "utf8"));
  const packages = (config.client || [])
    .map(client => client?.client_info?.android_client_info?.package_name)
    .filter(Boolean);
  if (!packages.includes(expectedPackage)) {
    errors.push(`Android Firebase package must include ${expectedPackage}`);
  }
}

if (!fs.existsSync(iosPath)) {
  errors.push(`Missing ${iosPath}`);
} else {
  const plist = fs.readFileSync(iosPath, "utf8");
  const bundleMatch = plist.match(/<key>BUNDLE_ID<\/key>\s*<string>([^<]+)<\/string>/);
  if (bundleMatch?.[1] !== expectedPackage) {
    errors.push(`iOS Firebase bundle id must be ${expectedPackage}`);
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`Firebase configuration matches ${expectedPackage} for Android and iOS.`);
