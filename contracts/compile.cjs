// Compiles SqueekPot.sol into SqueekPot.json (ABI + bytecode), which the page
// uses to deploy and the bot uses to settle.
//   cd contracts  &&  npm ci  &&  npm run compile
// The tests (npm test) compile it again and check SqueekPot.json still matches.
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const SETTINGS = { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" };

function compile(file = "SqueekPot.sol") {
  const source = fs.readFileSync(path.join(__dirname, file), "utf8");
  const input = {
    language: "Solidity",
    sources: { "SqueekPot.sol": { content: source } },
    settings: { ...SETTINGS, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const problems = out.errors || [];
  const errors = problems.filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts["SqueekPot.sol"].SqueekPot;
  return {
    warnings: problems.map((e) => e.formattedMessage),
    artifact: {
      contractName: "SqueekPot",
      compiler: solc.version(),
      settings: SETTINGS,
      abi: c.abi,
      bytecode: "0x" + c.evm.bytecode.object,
    },
  };
}

module.exports = { compile };

if (require.main === module) {
  try {
    const { warnings, artifact } = compile();
    warnings.forEach((w) => console.error(w));
    fs.writeFileSync(path.join(__dirname, "SqueekPot.json"), JSON.stringify(artifact, null, 1) + "\n");
    console.log(`SqueekPot.json written: ${(artifact.bytecode.length - 2) / 2} bytes of bytecode, compiler ${artifact.compiler}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
