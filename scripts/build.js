const fs = require("node:fs");
const path = require("node:path");

const requiredFiles = [
  "public/index.html",
  "public/styles.css",
  "public/load.js",
  "public/app.js",
  "functions/api/stats/latest.js",
];

const missingFiles = requiredFiles.filter((file) => {
  return !fs.existsSync(path.join(process.cwd(), file));
});

if (missingFiles.length > 0) {
  console.error(`Missing required files:\n${missingFiles.join("\n")}`);
  process.exit(1);
}

console.log("Static Cloudflare Pages build is ready in public/.");
