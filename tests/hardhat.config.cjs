// The local chain the bot tests run against (hardhat's own, chain id 31337). Nothing is compiled
// here: the tests deploy the contracts' committed .json files.
module.exports = { networks: { hardhat: { chainId: 31337 } }, paths: { sources: "./no-sources" } };
