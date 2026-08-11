const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const appVersion = require(path.join(root, "package.json")).version;
const extensionVersion = require(path.join(root, "extension", "manifest.json")).version;
const releaseRoot = path.join(root, "release");
const versionDirectory = path.join(releaseRoot, appVersion);

fs.mkdirSync(versionDirectory, { recursive: true });

const artifacts = [
  `Mosaic-Setup-${appVersion}.exe`,
  `Mosaic-Setup-${appVersion}.exe.blockmap`,
  `Mosaic-Extension-${extensionVersion}.zip`,
  `Mosaic-Extension-${extensionVersion}`,
  "latest.yml",
  "builder-debug.yml",
  "win-unpacked",
];

for (const artifact of artifacts) {
  const source = path.join(releaseRoot, artifact);
  const destination = path.join(versionDirectory, artifact);
  if (!fs.existsSync(source) || path.resolve(source) === path.resolve(destination)) continue;
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(source, destination);
}
