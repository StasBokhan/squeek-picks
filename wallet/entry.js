// Reown AppKit wallet picker for Squeek Picks.
// Bundled into ../wallet.js by `npm run build`. The page loads that file only when
// config.js has a REOWN_PROJECT_ID, and falls back to the browser wallet otherwise.
import { createAppKit } from "@reown/appkit";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { sepolia as baseSepolia } from "@reown/appkit/networks";

function create(opts) {
  // Sepolia with the same working RPC the page uses, so a wallet that adds the
  // network through the picker never ends up on a dead address.
  const sepolia = {
    ...baseSepolia,
    rpcUrls: { default: { http: [opts.rpcUrl] }, public: { http: [opts.rpcUrl] } },
    blockExplorers: { default: { name: "Etherscan", url: opts.explorer } },
  };

  const kit = createAppKit({
    adapters: [new EthersAdapter()],
    networks: [sepolia],
    defaultNetwork: sepolia,
    projectId: opts.projectId,
    metadata: {
      name: "Squeek Picks",
      description: "Call Squeektoshi's night on the wheel.",
      url: location.origin,
      icons: [opts.icon],
    },
    features: { analytics: false, email: false, socials: false, swaps: false, onramp: false, send: false, history: false },
    // Follows the page: dark by default, light when the visitor switched.
    themeMode: opts.theme === "light" ? "light" : "dark",
    themeVariables: {
      "--w3m-accent": "#FF8A2A",
      "--w3m-border-radius-master": "4px",
      "--w3m-font-family": "'Nunito Sans', system-ui, sans-serif",
      "--w3m-z-index": 1000,
    },
    allowUnsupportedChain: false,
  });

  const listeners = new Set();
  const read = () => {
    const address = kit.getAddress() || null;
    const info = kit.getWalletInfo() || {};
    const chainId = Number(kit.getChainId()) || null;
    return { address, chainId, connected: !!address && kit.getIsConnectedState(), walletName: info.name || "", walletIcon: info.icon || "" };
  };
  let last = "";
  const emit = () => {
    const s = read();
    const key = JSON.stringify(s);
    if (key === last) return;
    last = key;
    listeners.forEach((fn) => { try { fn(s); } catch (e) { console.error(e); } });
  };
  kit.subscribeAccount(emit);
  kit.subscribeNetwork(emit);
  kit.subscribeWalletInfo(emit);
  kit.subscribeProviders(emit);

  return {
    open: (view) => kit.open(view ? { view } : undefined),
    disconnect: () => kit.disconnect(),
    provider: () => kit.getWalletProvider(),
    state: read,
    subscribe(fn) { listeners.add(fn); fn(read()); return () => listeners.delete(fn); },
    switchToSepolia: () => kit.switchNetwork(sepolia),
    setTheme: (mode) => kit.setThemeMode(mode === "light" ? "light" : "dark"),
  };
}

window.SqueekWallet = { create };
