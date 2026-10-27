// Compiles SqueekPot.sol into SqueekPot.json (ABI + bytecode), which the page
// uses to deploy and the bot uses to settle.
//   npm install solc@0.8.24  &&  node contracts/compile.cjs
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const source = fs.readFileSync(path.join(__dirname, "SqueekPot.sol"), "utf8");
const input = {
  language: "Solidity",
  sources: { "SqueekPot.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "cancun",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === "error");
(out.errors || []).forEach((e) => console.error(e.formattedMessage));
if (errors.length) process.exit(1);

const c = out.contracts["SqueekPot.sol"].SqueekPot;
const artifact = {
  contractName: "SqueekPot",
  compiler: solc.version(),
  settings: { optimizer: input.settings.optimizer, evmVersion: input.settings.evmVersion },
  abi: c.abi,
  bytecode: "0x" + c.evm.bytecode.object,
};
fs.writeFileSync(path.join(__dirname, "SqueekPot.json"), JSON.stringify(artifact, null, 1) + "\n");
console.log(`SqueekPot.json written: ${(artifact.bytecode.length - 2) / 2} bytes of bytecode, compiler ${artifact.compiler}`);
