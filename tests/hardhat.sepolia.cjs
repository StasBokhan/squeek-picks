// The local chain the page tests run against: it answers as Sepolia (chain id 11155111), so the
// page treats it as the real test network.
module.exports = { networks: { hardhat: { chainId: 11155111 } }, paths: { sources: "./no-sources" } };
