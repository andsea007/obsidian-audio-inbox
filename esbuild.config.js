const esbuild = require("esbuild");
const process = require("process");

const prod = process.argv[2] === "production";

async function build() {
  if (prod) {
    // Production: single build
    await esbuild.build({
      entryPoints: ["main.ts"],
      bundle: true,
      external: ["obsidian", "electron"],
      platform: "node",
      format: "cjs",
      target: "es2018",
      logLevel: "info",
      sourcemap: false,
      treeShaking: true,
      outfile: "main.js",
      minify: true,
    });
    process.exit(0);
  } else {
    // Dev: watch mode
    const ctx = await esbuild.context({
      entryPoints: ["main.ts"],
      bundle: true,
      external: ["obsidian", "electron"],
      platform: "node",
      format: "cjs",
      target: "es2018",
      logLevel: "info",
      sourcemap: "inline",
      treeShaking: true,
      outfile: "main.js",
    });
    await ctx.watch();
    console.log("Watching for changes...");
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
