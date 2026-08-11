const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const version = require(path.join(root, "package.json")).version;
const outputDirectory = path.join(root, "release");
const extensionDirectory = path.join(root, "extension");
const unpackedOutput = path.join(outputDirectory, `Mosaic-Extension-${version}`);
const output = path.join(outputDirectory, `Mosaic-Extension-${version}.zip`);

fs.mkdirSync(outputDirectory, { recursive: true });
fs.rmSync(output, { force: true });
fs.rmSync(unpackedOutput, { recursive: true, force: true });
fs.cpSync(extensionDirectory, unpackedOutput, { recursive: true });
execFileSync("tar", ["-a", "-c", "-f", output, "-C", unpackedOutput, "."], {
  stdio: "inherit",
});
