// Reown AppKit wallet picker for Squeek Picks.
// Bundled into ../wallet.js by `npm run build`. The page loads that file only when
// config.js has a REOWN_PROJECT_ID, and falls back to the browser wallet otherwise.
import { createAppKit } from "@reown/appkit";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { sepolia as baseSepolia } from "@reown/appkit/networks";

const SEPOLIA_HEX = "0xaa36a7";

// A wallet's answer meaning "I don't know this network", which MetaMask, Rabby and others
// give as code 4902 (sometimes wrapped in originalError).
function unknownChain(e) {
  const code = e && (e.code != null ? e.code : e.data && e.data.originalError && e.data.originalError.code);
  return code === 4902 || /unrecognized chain|unknown chain|not been added|try adding the chain/i.test((e && e.message) || "");
}

// Some wallets, Rabby among them, don't come with Sepolia: it has to be added once.
// When connecting, AppKit (1.8.24) asks the wallet to switch to Sepolia and gives up on any
// error, so those wallets could never connect. This wraps a browser wallet's provider so a
// switch to Sepolia that the wallet doesn't know first offers to add Sepolia, the way
// AppKit already does when switching later.
function withAddSepolia(provider, opts) {
  if (!provider || provider.__squeekAddSepolia) return provider;
  const params = {
    chainId: SEPOLIA_HEX,
    chainName: "Sepolia",
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: [opts.rpcUrl],
    blockExplorerUrls: [opts.explorer],
  };
  const request = async (args) => {
    try {
      return await provider.request(args);
    } catch (e) {
      const want = args && args.method === "wallet_switchEthereumChain" && args.params && args.params[0] && String(args.params[0].chainId).toLowerCase();
      if (want !== SEPOLIA_HEX || !unknownChain(e)) throw e;
      await provider.request({ method: "wallet_addEthereumChain", params: [params] });
      // Most wallets also switch when they add a network; ask once more for those that don't.
      const now = await provider.request({ method: "eth_chainId" }).catch(() => null);
      if (String(now).toLowerCase() !== SEPOLIA_HEX) await provider.request(args);
      return null;
    }
  };
  return new Proxy(provider, {
    get(target, key) {
      if (key === "request") return request;
      if (key === "__squeekAddSepolia") return true;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function makeAdapter(opts) {
  class SqueekEthersAdapter extends EthersAdapter {
    async connect(params) {
      const connector = this.connectors.find((c) => c.id && params && params.id && c.id.toLowerCase() === String(params.id).toLowerCase());
      // Browser wallets only: WalletConnect and email logins have their own network handling.
      if (connector && connector.provider && ["ANNOUNCED", "INJECTED", "EXTERNAL"].includes(connector.type)) {
        connector.provider = withAddSepolia(connector.provider, opts);
      }
      return super.connect(params);
    }
  }
  return new SqueekEthersAdapter();
}

function create(opts) {
  // Sepolia with the same working RPC the page uses, so a wallet that adds the
  // network through the picker never ends up on a dead address.
  const sepolia = {
    ...baseSepolia,
    rpcUrls: { default: { http: [opts.rpcUrl] }, public: { http: [opts.rpcUrl] } },
    blockExplorers: { default: { name: "Etherscan", url: opts.explorer } },
  };

  const kit = createAppKit({
    adapters: [makeAdapter(opts)],
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
