const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const appVersion = require(path.join(root, "package.json")).version;
const extensionDirectory = path.join(root, "extension");
const extensionVersion = require(path.join(extensionDirectory, "manifest.json")).version;
const outputDirectory = path.join(root, "release", appVersion);
const unpackedOutput = path.join(outputDirectory, `Mosaic-Extension-${extensionVersion}`);
const output = path.join(outputDirectory, `Mosaic-Extension-${extensionVersion}.zip`);

fs.mkdirSync(outputDirectory, { recursive: true });
for (const entry of fs.readdirSync(outputDirectory)) {
  if (/^Mosaic-Extension-/.test(entry)) fs.rmSync(path.join(outputDirectory, entry), { recursive: true, force: true });
}
fs.rmSync(output, { force: true });
fs.rmSync(unpackedOutput, { recursive: true, force: true });
fs.cpSync(extensionDirectory, unpackedOutput, { recursive: true });
execFileSync("tar", ["-a", "-c", "-f", output, "-C", unpackedOutput, "."], {
  stdio: "inherit",
});
