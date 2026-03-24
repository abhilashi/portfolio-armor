import { ethers } from "ethers";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

const CHAINS = {
  ethereum: {
    rpc: "https://ethereum.publicnode.com",
    llama: "ethereum",
    tokens: {
      "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": "WETH",
      "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": "WBTC",
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "USDC",
      "0xdAC17F958D2ee523a2206206994597C13D831ec7": "USDT",
      "0x6B175474E89094C44Da98b954EedeAC495271d0F": "DAI",
      "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984": "UNI",
      "0x514910771AF9Ca656af840dff83E8264EcF986CA": "LINK",
      "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9": "AAVE",
      "0xD533a949740bb3306d119CC777fa900bA034cd52": "CRV",
      "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F": "SNX",
      "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2": "MKR",
      "0xae78736Cd615f374D3085123A210448E74Fc6393": "rETH",
      "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704": "cbETH",
      "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0": "wstETH",
      "0xba100000625a3754423978a60c9317c58a424e3D": "BAL",
      "0x1a7e4e63778B4f12a199C062f3eFdD288afCBce8": "agEUR",
      "0x4e3FBD56CD56c3e72c1403e103b45Db9da5B9D2B": "CVX",
      "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32": "LDO",
      "0x853d955aCEf822Db058eb8505911ED77F175b99e": "FRAX",
    },
  },
  arbitrum: {
    rpc: "https://arb1.arbitrum.io/rpc",
    llama: "arbitrum",
    tokens: {
      "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1": "WETH",
      "0xaf88d065e77c8cC2239327C5EDb3A432268e5831": "USDC",
      "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8": "USDC.e",
      "0x912CE59144191C1204E64559FE8253a0e49E6548": "ARB",
      "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a": "GMX",
      "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f": "WBTC",
      "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9": "USDT",
      "0x5979D7b546E38E9Ab8FB6bf37e5BCC6033EAe17e": "wstETH",
    },
  },
  optimism: {
    rpc: "https://mainnet.optimism.io",
    llama: "optimism",
    tokens: {
      "0x4200000000000000000000000000000000000006": "WETH",
      "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85": "USDC",
      "0x4200000000000000000000000000000000000042": "OP",
      "0x68f180fcCe6836688e9084f035309E29Bf0A2095": "WBTC",
      "0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb": "wstETH",
    },
  },
  base: {
    rpc: "https://mainnet.base.org",
    llama: "base",
    tokens: {
      "0x4200000000000000000000000000000000000006": "WETH",
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": "USDC",
      "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22": "cbETH",
      "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb": "DAI",
    },
  },
};

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const MULTICALL3_ABI = [
  "function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) view returns (tuple(bool success, bytes returnData)[])",
];

async function readChainBalances(chainName, chainConfig, wallet) {
  const provider = new ethers.JsonRpcProvider(chainConfig.rpc);
  const multicall = new ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider);
  const iface = new ethers.Interface(ERC20_ABI);

  // Native ETH balance
  const ethBalance = await provider.getBalance(wallet);
  const ethFormatted = parseFloat(ethers.formatEther(ethBalance));

  // Multicall for all tokens: balanceOf + decimals — normalize checksums
  const tokenAddrs = Object.keys(chainConfig.tokens).map((a) => ethers.getAddress(a.toLowerCase()));
  // Build reverse lookup: checksummed addr -> symbol
  const addrToSymbol = {};
  const origAddrs = Object.keys(chainConfig.tokens);
  for (let i = 0; i < origAddrs.length; i++) {
    addrToSymbol[tokenAddrs[i]] = chainConfig.tokens[origAddrs[i]];
  }
  const calls = tokenAddrs.flatMap((addr) => [
    {
      target: addr,
      allowFailure: true,
      callData: iface.encodeFunctionData("balanceOf", [wallet]),
    },
    {
      target: addr,
      allowFailure: true,
      callData: iface.encodeFunctionData("decimals", []),
    },
  ]);

  const results = await multicall.aggregate3(calls);

  const balances = [];
  for (let i = 0; i < tokenAddrs.length; i++) {
    const balRes = results[i * 2];
    const decRes = results[i * 2 + 1];
    if (!balRes.success || !decRes.success) continue;

    try {
      const balance = iface.decodeFunctionResult("balanceOf", balRes.returnData)[0];
      const decimals = iface.decodeFunctionResult("decimals", decRes.returnData)[0];
      const formatted = parseFloat(ethers.formatUnits(balance, decimals));

      if (formatted > 0) {
        balances.push({
          chain: chainName,
          address: tokenAddrs[i],
          symbol: addrToSymbol[tokenAddrs[i]],
          balance: formatted,
        });
      }
    } catch {
      // Skip tokens with undecodable return data
    }
  }

  return { ethBalance: ethFormatted, balances };
}

async function getPrices(tokensByChain) {
  const coins = Object.entries(tokensByChain)
    .flatMap(([chain, addrs]) => addrs.map((a) => `${chain}:${a}`))
    .join(",");

  if (!coins) return {};

  const url = `https://coins.llama.fi/prices/current/${coins}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DeFi Llama price fetch failed: ${res.status}`);
  const data = await res.json();
  return data.coins;
}

async function getEthPrice() {
  const res = await fetch(
    "https://coins.llama.fi/prices/current/coingecko:ethereum"
  );
  const data = await res.json();
  return data.coins["coingecko:ethereum"]?.price || 0;
}

export async function fetchOnchainPortfolio(walletAddress) {
  const allBalances = [];
  const tokensByChain = {};

  // Read balances from all chains in parallel
  const chainResults = await Promise.all(
    Object.entries(CHAINS).map(async ([name, config]) => {
      try {
        return { name, ...(await readChainBalances(name, config, walletAddress)) };
      } catch (e) {
        console.error(`Error reading ${name}: ${e.message}`);
        return { name, ethBalance: 0, balances: [] };
      }
    })
  );

  // Collect token addresses for price lookup
  for (const result of chainResults) {
    const chain = CHAINS[result.name];
    const addrs = result.balances.map((b) => b.address);
    if (addrs.length > 0) {
      tokensByChain[chain.llama] = addrs;
    }
    allBalances.push(...result.balances);
  }

  // Fetch prices
  const [tokenPrices, ethPrice] = await Promise.all([
    getPrices(tokensByChain).catch(() => ({})),
    getEthPrice(),
  ]);

  // Build positions
  const positions = [];
  const stablecoins = new Set(["USDC", "USDC.e", "USDT", "DAI", "FRAX", "agEUR"]);

  // Native ETH across chains
  let totalEth = 0;
  for (const result of chainResults) {
    totalEth += result.ethBalance;
  }
  if (totalEth > 0.0001) {
    positions.push({
      source: `onchain`,
      asset: "ETH",
      side: "LONG",
      size: totalEth,
      price: ethPrice,
      valueUsd: totalEth * ethPrice,
    });
  }

  let stablecoinBalance = 0;

  for (const bal of allBalances) {
    const key = `${CHAINS[bal.chain].llama}:${bal.address}`;
    const price = tokenPrices[key]?.price || 0;
    const value = bal.balance * price;

    if (stablecoins.has(bal.symbol)) {
      stablecoinBalance += value;
      continue;
    }

    if (value < 1) continue; // Skip dust

    // Map wrapped tokens to their base for options matching
    let baseAsset = bal.symbol;
    if (["WETH", "wstETH", "rETH", "cbETH"].includes(bal.symbol)) baseAsset = "ETH";
    if (["WBTC"].includes(bal.symbol)) baseAsset = "BTC";

    positions.push({
      source: `onchain-${bal.chain}`,
      asset: baseAsset,
      originalToken: bal.symbol,
      side: "LONG",
      size: bal.balance,
      price,
      valueUsd: value,
    });
  }

  return { positions, stablecoinBalance };
}
