// Compiles the contracts into their .json files (ABI + bytecode), which the page uses to
// deploy and the bots use to call them:
//   SqueekPot.sol        -> SqueekPot.json         the nightly pot
//   SqueekNightCards.sol -> SqueekNightCards.json  the Night Cards collectibles
//   cd contracts  &&  npm ci  &&  npm run compile
// The tests (npm test) compile them again and check the .json files still match.
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const SETTINGS = { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" };
const CONTRACTS = [
  { file: "SqueekPot.sol", name: "SqueekPot", json: "SqueekPot.json" },
  { file: "SqueekNightCards.sol", name: "SqueekNightCards", json: "SqueekNightCards.json" },
];

// Imports (OpenZeppelin) come from node_modules.
function findImports(p) {
  try { return { contents: fs.readFileSync(require.resolve(p, { paths: [__dirname] }), "utf8") }; }
  catch (e) { return { error: "Not found: " + p }; }
}

// `file` is read from this folder but always compiled under the contract's own source name,
// so an older copy (SqueekPotV2.sol) compiles to exactly what was deployed from it.
function compile(file = "SqueekPot.sol", name = "SqueekPot") {
  const source = fs.readFileSync(path.join(__dirname, file), "utf8");
  const key = name + ".sol";
  const input = {
    language: "Solidity",
    sources: { [key]: { content: source } },
    settings: { ...SETTINGS, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
  const problems = out.errors || [];
  const errors = problems.filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts[key][name];
  return {
    warnings: problems.map((e) => e.formattedMessage),
    size: c.evm.deployedBytecode.object.length / 2,
    artifact: {
      contractName: name,
      compiler: solc.version(),
      settings: SETTINGS,
      abi: c.abi,
      bytecode: "0x" + c.evm.bytecode.object,
    },
  };
}

module.exports = { compile, CONTRACTS };

if (require.main === module) {
  try {
    for (const c of CONTRACTS) {
      const { warnings, artifact, size } = compile(c.file, c.name);
      warnings.forEach((w) => console.error(w));
      fs.writeFileSync(path.join(__dirname, c.json), JSON.stringify(artifact, null, 1) + "\n");
      console.log(`${c.json} written: ${size} bytes deployed (limit 24,576), compiler ${artifact.compiler}`);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
