// Only used to run the tests on hardhat's built-in chain. The pot is compiled with
// compile.cjs (solc directly), and the tests deploy SqueekPot.json.
require("@nomicfoundation/hardhat-ethers");

module.exports = {
  networks: {
    // Starts the chain at 1970-01-01, so the tests can check the pot works from
    // time zero (the audit found version 2's openNight() underflowed there).
    hardhat: { chainId: 31337, initialDate: "1970-01-01T00:00:00Z" },
  },
  paths: { sources: "./no-hardhat-sources" },
  mocha: { timeout: 300000 },
};
