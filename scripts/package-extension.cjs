const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const version = require(path.join(root, "package.json")).version;
const outputDirectory = path.join(root, "release");
const output = path.join(outputDirectory, `Mosaic-Extension-${version}.zip`);

fs.mkdirSync(outputDirectory, { recursive: true });
fs.rmSync(output, { force: true });
execFileSync("tar", ["-a", "-c", "-f", output, "-C", path.join(root, "extension"), "."], {
  stdio: "inherit",
});
