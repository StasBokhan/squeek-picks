// Builds the page you host from src/.
//   node build.mjs                 ->  index.html (complete page for any static host)
//   node build.mjs --fragment out  ->  also writes a body-only copy (used for previews)
// It inlines src/logic.js and the pot contract (contracts/SqueekPot.json).
// Your settings stay in config.js, which this never touches.
import { readFileSync, writeFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
let src = read("./src/app.html");
const logic = read("./src/logic.js");
const pot = JSON.parse(read("./contracts/SqueekPot.json"));

const swap = (from, to) => {
  if (!src.includes(from)) throw new Error(`build: marker not found: ${from}`);
  src = src.split(from).join(to);
};
swap('<script src="logic.js" data-inline></script>', "<script>\n" + logic.trim() + "\n</script>");
swap("/*@@POT_ABI@@*/[]", JSON.stringify(pot.abi));
swap('/*@@POT_BYTECODE@@*/""', JSON.stringify(pot.bytecode));

const [head, body] = src.split("<!-- BODY -->");
if (!body) throw new Error("src/app.html needs a <!-- BODY --> marker");

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#14141b">
${head.trim()}
</head>
<body>
${body.trim()}
</body>
</html>
`;
writeFileSync(new URL("./index.html", import.meta.url), page);
console.log(`index.html  ${(page.length / 1024).toFixed(1)} KB`);

const i = process.argv.indexOf("--fragment");
if (i > 0 && process.argv[i + 1]) {
  writeFileSync(process.argv[i + 1], head.trim() + "\n" + body.trim() + "\n");
  console.log(`fragment    ${process.argv[i + 1]}`);
}
