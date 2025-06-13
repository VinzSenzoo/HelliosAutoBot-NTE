import blessed from "blessed";
import chalk from "chalk";
import figlet from "figlet";
import { ethers } from "ethers";
import fs from "fs";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

const RPC_URL = "https://testnet1.helioschainlabs.org/";
const CONFIG_FILE = "config.json";
const TOKEN_ADDRESS = "0xD4949664cD82660AaE99bEdc034a0deA8A0bd517";
const BRIDGE_ROUTER_ADDRESS = "0x0000000000000000000000000000000000000900";
const STAKE_ROUTER_ADDRESS = "0x0000000000000000000000000000000000000800";
const CHAIN_ID = 42000;
const availableChains = [11155111, 43113, 97, 80002];
const chainNames = {
  11155111: "Sepolia",
  43113: "Fuji",
  97: "BSC Testnet",
  80002: "Amoy"
};

const availableValidators = [
  { name: "helios-hedge", address: "0x007a1123a54cdd9ba35ad2012db086b9d8350a5f" },
  { name: "helios-supra", address: "0x882f8a95409c127f0de7ba83b4dfa0096c3d8d79" }
];

const isDebug = false;

let walletInfo = {
  address: "N/A",
  balanceHLS: "0.0000",
  activeAccount: "N/A"
};
let transactionLogs = [];
let activityRunning = false;
let isCycleRunning = false;
let shouldStop = false;
let dailyActivityInterval = null;
let privateKeys = [];
let proxies = [];
let selectedWalletIndex = 0;
let loadingSpinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const borderBlinkColors = ["cyan", "blue", "magenta", "red", "yellow", "green"];
let borderBlinkIndex = 0;
let blinkCounter = 0;
let spinnerIndex = 0;
let nonceTracker = {};
let hasLoggedSleepInterrupt = false;
let isHeaderRendered = false;
let activeProcesses = 0;

let dailyActivityConfig = {
  bridgeRepetitions: 1,
  minHlsBridge: 0.001,
  maxHlsBridge: 0.004,
  stakeRepetitions: 1,
  minHlsStake: 0.01,
  maxHlsStake: 0.03
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, "utf8");
      const config = JSON.parse(data);
      dailyActivityConfig.bridgeRepetitions = Number(config.bridgeRepetitions) || 1;
      dailyActivityConfig.minHlsBridge = Number(config.minHlsBridge) || 0.001;
      dailyActivityConfig.maxHlsBridge = Number(config.maxHlsBridge) || 0.004;
      dailyActivityConfig.stakeRepetitions = Number(config.stakeRepetitions) || 1;
      dailyActivityConfig.minHlsStake = Number(config.minHlsStake) || 0.01;
      dailyActivityConfig.maxHlsStake = Number(config.maxHlsStake) || 0.03;
    } else {
      addLog("No config file found, using default settings.", "info");
    }
  } catch (error) {
    addLog(`Failed to load config: ${error.message}`, "error");
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(dailyActivityConfig, null, 2));
    addLog("Configuration saved successfully.", "success");
  } catch (error) {
    addLog(`Failed to save config: ${error.message}`, "error");
  }
}

async function makeJsonRpcCall(method, params) {
  try {
    const id = uuidv4();
    const proxyUrl = proxies[selectedWalletIndex % proxies.length] || null; 
    const agent = createAgent(proxyUrl);
    const response = await axios.post(RPC_URL, {
      jsonrpc: "2.0",
      id,
      method,
      params
    }, {
      headers: { "Content-Type": "application/json" },
      httpsAgent: agent 
    });
    const data = response.data;
    if (data.error) {
      throw new Error(`RPC Error: ${data.error.message} (code: ${data.error.code})`);
    }
    if (!data.result && data.result !== "") {
      throw new Error("No result in RPC response");
    }
    return data.result;
  } catch (error) {
    const errorMessage = error.response
      ? `HTTP ${error.response.status}: ${error.message}`
      : error.message;
    addLog(`JSON-RPC call failed (${method}): ${errorMessage}`, "error");
    throw error;
  }
}

process.on("unhandledRejection", (reason, promise) => {
  addLog(`Unhandled Rejection at: ${promise}, reason: ${reason.message || reason}`, "error");
});

process.on("uncaughtException", (error) => {
  addLog(`Uncaught Exception: ${error.message}\n${error.stack}`, "error");
  process.exit(1);
});

function getShortAddress(address) {
  return address ? address.slice(0, 6) + "..." + address.slice(-4) : "N/A";
}

function addLog(message, type = "info") {
  if (type === "debug" && !isDebug) return;
  const timestamp = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
  let coloredMessage;
  switch (type) {
    case "error":
      coloredMessage = chalk.redBright(message);
      break;
    case "success":
      coloredMessage = chalk.greenBright(message);
      break;
    case "wait":
      coloredMessage = chalk.yellowBright(message);
      break;
    case "info":
      coloredMessage = chalk.whiteBright(message);
      break;
    case "delay":
      coloredMessage = chalk.cyanBright(message);
      break;
    case "debug":
      coloredMessage = chalk.blueBright(message);
      break;
    default:
      coloredMessage = chalk.white(message);
  }
  const logMessage = `[${timestamp}] ${coloredMessage}`;
  transactionLogs.push(logMessage);
  updateLogs();
}

function getShortHash(hash) {
  return hash.slice(0, 6) + "..." + hash.slice(-4);
}

function clearTransactionLogs() {
  transactionLogs = [];
  logBox.setContent('');
  logBox.scrollTo(0);
  addLog("Transaction logs cleared.", "success");
}

function loadPrivateKeys() {
  try {
    const data = fs.readFileSync("pk.txt", "utf8");
    privateKeys = data.split("\n").map(key => key.trim()).filter(key => key.match(/^(0x)?[0-9a-fA-F]{64}$/));
    if (privateKeys.length === 0) throw new Error("No valid private keys in pk.txt");
    addLog(`Loaded ${privateKeys.length} private keys from pk.txt`, "success");
  } catch (error) {
    addLog(`Failed to load private keys: ${error.message}`, "error");
    privateKeys = [];
  }
}

function loadProxies() {
  try {
    if (fs.existsSync("proxy.txt")) {
      const data = fs.readFileSync("proxy.txt", "utf8");
      proxies = data.split("\n").map(proxy => proxy.trim()).filter(proxy => proxy);
      if (proxies.length === 0) throw new Error("No proxy found in proxy.txt");
      addLog(`Loaded ${proxies.length} proxies from proxy.txt`, "success");
    } else {
      addLog("No proxy.txt found, running without proxy.", "info");
    }
  } catch (error) {
    addLog(`Failed to load proxy: ${error.message}`, "info");
    proxies = [];
  }
}

function createAgent(proxyUrl) {
  if (!proxyUrl) return null;
  if (proxyUrl.startsWith("socks")) {
    return new SocksProxyAgent(proxyUrl);
  } else {
    return new HttpsProxyAgent(proxyUrl);
  }
}

function getProviderWithProxy(proxyUrl, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const agent = createAgent(proxyUrl);
      const fetchOptions = agent ? { agent } : {};
      const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: "Helios" }, { fetchOptions });
      provider.getNetwork().then(network => {
        if (Number(network.chainId) !== CHAIN_ID) {
          throw new Error(`Network chain ID mismatch: expected ${CHAIN_ID}, got ${network.chainId}`);
        }
      }).catch(err => {
        throw err;
      });
      return provider;
    } catch (error) {
      addLog(`Attempt ${attempt}/${maxRetries} failed to initialize provider: ${error.message}`, "error");
      if (attempt < maxRetries) sleep(1000);
    }
  }
  try {
    addLog(`Proxy failed, falling back to direct connection`, "warn");
    const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: "Helios" });
    provider.getNetwork().then(network => {
      if (Number(network.chainId) !== CHAIN_ID) {
        throw new Error(`Network chain ID mismatch: expected ${CHAIN_ID}, got ${network.chainId}`);
      }
    }).catch(err => {
      throw err;
    });
    return provider;
  } catch (error) {
    addLog(`Fallback failed: ${error.message}`, "error");
    throw error;
  }
}

async function sleep(ms) {
  if (shouldStop) {
    if (!hasLoggedSleepInterrupt) {
      addLog("Process stopped successfully.", "info");
      hasLoggedSleepInterrupt = true;
    }
    return;
  }
  activeProcesses++;
  try {
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve();
      }, ms);
      const checkStop = setInterval(() => {
        if (shouldStop) {
          clearTimeout(timeout);
          clearInterval(checkStop);
          if (!hasLoggedSleepInterrupt) {
            addLog("Process interrupted.", "info");
            hasLoggedSleepInterrupt = true;
          }
          resolve();
        }
      }, 100);
    });
  } catch (error) {
    addLog(`Sleep error: ${error.message}`, "error");
  } finally {
    activeProcesses = Math.max(0, activeProcesses - 1);
  }
}

async function updateWalletData() {
  const tokenAbi = ["function balanceOf(address) view returns (uint256)"];
  const walletDataPromises = privateKeys.map(async (privateKey, i) => {
    try {
      const proxyUrl = proxies[i % proxies.length] || null;
      const provider = getProviderWithProxy(proxyUrl);
      const wallet = new ethers.Wallet(privateKey, provider);
      
      const tokenContract = new ethers.Contract(TOKEN_ADDRESS, tokenAbi, provider);
      const hlsBalance = await tokenContract.balanceOf(wallet.address);
      
      const formattedHLS = Number(ethers.formatUnits(hlsBalance, 18)).toFixed(4);
      
      const formattedEntry = `${i === selectedWalletIndex ? "→ " : "  "}${chalk.bold.magentaBright(getShortAddress(wallet.address))}              ${chalk.bold.cyanBright(formattedHLS.padEnd(8))}`;
      
      if (i === selectedWalletIndex) {
        walletInfo.address = wallet.address;
        walletInfo.activeAccount = `Account ${i + 1}`;
        walletInfo.balanceHLS = formattedHLS;
      }
      return formattedEntry;
    } catch (error) {
      addLog(`Failed to fetch wallet data for account #${i + 1}: ${error.message}`, "error");
      return `${i === selectedWalletIndex ? "→ " : "  "}N/A 0.0000`;
    }
  });
  try {
    const walletData = await Promise.all(walletDataPromises);
    addLog("Wallet data updated.", "success");
    return walletData;
  } catch (error) {
    addLog(`Wallet data update failed: ${error.message}`, "error");
    return [];
  }
}

async function getNextNonce(provider, walletAddress) {
  if (shouldStop) {
    addLog("Nonce fetch stopped due to stop request.", "info");
    throw new Error("Process stopped");
  }
  if (!walletAddress || !ethers.isAddress(walletAddress)) {
    addLog(`Invalid wallet address: ${walletAddress}`, "error");
    throw new Error("Invalid wallet address");
  }
  try {
    const pendingNonce = await provider.getTransactionCount(walletAddress, "pending");
    const lastUsedNonce = nonceTracker[walletAddress] || pendingNonce - 1;
    const nextNonce = Math.max(pendingNonce, lastUsedNonce + 1);
    nonceTracker[walletAddress] = nextNonce;
    addLog(`Debug: Fetched nonce ${nextNonce} for ${getShortAddress(walletAddress)}`, "debug");
    return nextNonce;
  } catch (error) {
    addLog(`Failed to fetch nonce for ${getShortAddress(walletAddress)}: ${error.message}`, "error");
    throw error;
  }
}

async function bridge(wallet, amount, recipient, destChainId) {
  try {
    if (!wallet.address || !ethers.isAddress(wallet.address)) {
      throw new Error(`Invalid wallet address: ${wallet.address}`);
    }
    addLog(`Debug: Building bridge transaction for amount ${amount} HLS to ${getShortAddress(wallet.address)}`, "debug");
    const chainIdHex = ethers.toBeHex(destChainId).slice(2).padStart(64, '0');
    const offset = "00000000000000000000000000000000000000000000000000000000000000a0";
    const token = TOKEN_ADDRESS.toLowerCase().slice(2).padStart(64, '0');
    addLog(`Debug: Converting amount ${amount} to wei`, "debug");
    const amountWei = ethers.parseUnits(amount.toString(), 18);
    addLog(`Debug: amountWei: ${amountWei.toString()}`, "debug");
    
    let amountHexRaw;
    try {
      amountHexRaw = ethers.toBeHex(amountWei);
      addLog(`Debug: amountHexRaw: ${amountHexRaw}`, "debug");
    } catch (error) {
      addLog(`Debug: Failed to convert amountWei to hex: ${error.message}`, "error");
      throw new Error(`Hex conversion failed: ${error.message}`);
    }
    
    let amountHex;
    try {
      amountHex = ethers.zeroPadValue(amountHexRaw, 32).slice(2);
      addLog(`Debug: amountHex padded: ${amountHex}`, "debug");
    } catch (error) {
      addLog(`Debug: Failed to pad amountHex: ${error.message}`, "error");
      throw new Error(`Hex padding failed: ${error.message}`);
    }
    
    const gasParam = ethers.toBeHex(ethers.parseUnits("1", "gwei")).slice(2).padStart(64, '0');
    addLog(`Debug: Encoding recipient ${recipient} as string`, "debug");
    const recipientString = `0x${recipient.toLowerCase().slice(2)}`;
    const recipientLength = ethers.toBeHex(recipientString.length).slice(2).padStart(64, '0');
    const recipientPadded = Buffer.from(recipientString).toString('hex').padEnd(64, '0');
    
    const inputData = "0x7ae4a8ff" + 
      chainIdHex + 
      offset + 
      token + 
      amountHex + 
      gasParam + 
      recipientLength + 
      recipientPadded;
    addLog(`Debug: inputData: ${inputData}`, "debug");

    const tokenAbi = [
      "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)"
    ];
    const tokenContract = new ethers.Contract(TOKEN_ADDRESS, tokenAbi, wallet);
    const allowance = await tokenContract.allowance(wallet.address, BRIDGE_ROUTER_ADDRESS);
    addLog(`Debug: Allowance: ${allowance.toString()}`, "debug");
    if (allowance < amountWei) {
      addLog(`Approving router to spend ${amount} HLS`, "info");
      const approveTx = await tokenContract.approve(BRIDGE_ROUTER_ADDRESS, amountWei);
      await approveTx.wait();
      addLog("Approval successful", "success");
    }

    const tx = {
      to: BRIDGE_ROUTER_ADDRESS,
      data: inputData,
      gasLimit: 1500000,
      chainId: CHAIN_ID,
      nonce: await getNextNonce(wallet.provider, wallet.address)
    };
    addLog(`Debug: Transaction object: ${JSON.stringify(tx)}`, "debug");
    
    const sentTx = await wallet.sendTransaction(tx);
    addLog(`Bridge transaction sent: ${getShortHash(sentTx.hash)}`, "success");
    const receipt = await sentTx.wait();
    
    if (receipt.status === 0) {
      addLog(`Bridge transaction reverted: ${JSON.stringify(receipt)}`, "error");
      throw new Error("Transaction reverted");
    }
    
    try {
      const historyResult = await makeJsonRpcCall("eth_getHyperionAccountTransferTxsByPageAndSize", [
        wallet.address,
        "0x1",
        "0xa"
      ]);
    } catch (rpcError) {
      addLog(`Failed to sync with portal via JSON-RPC: ${rpcError.message}`, "error");
    }
    
    addLog("Bridge Transaction Confirmed And Synced With Portal", "success");
  } catch (error) {
    addLog(`Bridge operation failed: ${error.message}`, "error");
    if (error.reason) {
      addLog(`Revert reason: ${error.reason}`, "error");
    }
    if (error.receipt) {
      addLog(`Transaction receipt: ${JSON.stringify(error.receipt)}`, "debug");
    }
    throw error;
  }
}

async function stake(wallet, amount, validatorAddress, validatorName) {
  try {
    if (!wallet.address || !ethers.isAddress(wallet.address)) {
      throw new Error(`Invalid wallet address: ${wallet.address}`);
    }
    addLog(`Debug: Building stake transaction for amount ${amount} HLS to validator ${validatorName || validatorAddress}`, "debug");
    
    const fixedBytes = "ahelios";
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const encodedData = abiCoder.encode(
      ["address", "address", "uint256", "bytes"],
      [wallet.address, validatorAddress, ethers.parseUnits(amount.toString(), 18), ethers.toUtf8Bytes(fixedBytes)]
    );
    const inputData = "0xf5e56040" + encodedData.slice(2);
    
    const tx = {
      to: STAKE_ROUTER_ADDRESS,
      data: inputData,
      gasLimit: 1500000,
      chainId: CHAIN_ID,
      nonce: await getNextNonce(wallet.provider, wallet.address)
    };
    addLog(`Debug: Stake transaction object: ${JSON.stringify(tx)}`, "debug");
    const sentTx = await wallet.sendTransaction(tx);
    addLog(`Stake transaction sent: ${getShortHash(sentTx.hash)}`, "success");
    const receipt = await sentTx.wait();
    if (receipt.status === 0) {
      addLog(`Stake transaction reverted: ${JSON.stringify(receipt)}`, "error");
      throw new Error("Transaction reverted");
    }
    
    try {
      const historyResult = await makeJsonRpcCall("eth_getAccountLastTransactionsInfo", [wallet.address]);
    } catch (rpcError) {
      addLog(`Failed to sync with portal via JSON-RPC: ${rpcError.message}`, "error");
    }
    
    addLog("Stake Transaction Confirmed And Synced With Portal", "success");
  } catch (error) {
    addLog(`Stake operation failed: ${error.message}`, "error");
    if (error.reason) {
      addLog(`Revert reason: ${error.reason}`, "error");
    }
    if (error.receipt) {
      addLog(`Transaction receipt: ${JSON.stringify(error.receipt)}`, "debug");
    }
    throw error;
  }
}

async function runDailyActivity() {
  if (privateKeys.length === 0) {
    addLog("No valid private keys found.", "error");
    return;
  }
  addLog(`Starting daily activity for all accounts. Auto Bridge: ${dailyActivityConfig.bridgeRepetitions}x, Auto Stake: ${dailyActivityConfig.stakeRepetitions}x`, "info");
  activityRunning = true;
  isCycleRunning = true;
  shouldStop = false;
  hasLoggedSleepInterrupt = false;
  activeProcesses = Math.max(0, activeProcesses);
  updateMenu();
  try {
    for (let accountIndex = 0; accountIndex < privateKeys.length && !shouldStop; accountIndex++) {
      addLog(`Starting processing for account ${accountIndex + 1}`, "info");
      selectedWalletIndex = accountIndex;
      const proxyUrl = proxies[accountIndex % proxies.length] || null;
      let provider;
      addLog(`Account ${accountIndex + 1}: Using Proxy ${proxyUrl || "none"}`, "info");
      try {
        provider = await getProviderWithProxy(proxyUrl);
        await provider.getNetwork();
      } catch (error) {
        addLog(`Failed to connect to provider for account ${accountIndex + 1}: ${error.message}`, "error");
        continue;
      }
      const wallet = new ethers.Wallet(privateKeys[accountIndex], provider);
      if (!ethers.isAddress(wallet.address)) {
        addLog(`Invalid wallet address for account ${accountIndex + 1}: ${wallet.address}`, "error");
        continue;
      }
      addLog(`Processing account ${accountIndex + 1}: ${getShortAddress(wallet.address)}`, "wait");

      const shuffledChains = [...availableChains].sort(() => Math.random() - 0.5);

      for (let bridgeCount = 0; bridgeCount < dailyActivityConfig.bridgeRepetitions && !shouldStop; bridgeCount++) {
        const destChainId = shuffledChains[bridgeCount % shuffledChains.length];
        const destChainName = chainNames[destChainId] || "Unknown";
        const amountHLS = (Math.random() * (dailyActivityConfig.maxHlsBridge - dailyActivityConfig.minHlsBridge) + dailyActivityConfig.minHlsBridge).toFixed(4);
        const amountWei = ethers.parseUnits(amountHLS, 18);
        try {
          const nativeBalance = await provider.getBalance(wallet.address);
          const tokenContract = new ethers.Contract(TOKEN_ADDRESS, ["function balanceOf(address) view returns (uint256)"], provider);
          const hlsBalance = await tokenContract.balanceOf(wallet.address);
          addLog(`Account ${accountIndex + 1} - Bridge ${bridgeCount + 1}: HLS Balance: ${ethers.formatUnits(hlsBalance, 18)}`, "wait");
          addLog(`Account ${accountIndex + 1} - Bridge ${bridgeCount + 1}: Bridge ${amountHLS} HLS Hellios ➯  ${destChainName}`, "info");
          let gasPrice = (await provider.getFeeData()).maxFeePerGas;
          if (!gasPrice) {
            gasPrice = ethers.parseUnits("1", "gwei");
            addLog(`Using default gas price: 1 gwei`, "info");
          }
          const gasLimit = BigInt(1500000);
          const gasCost = gasPrice * gasLimit;
          if (nativeBalance < gasCost) {
            addLog(`Account ${accountIndex + 1} - Bridge ${bridgeCount + 1}: Insufficient native balance (${ethers.formatEther(nativeBalance)} HLS)`, "error");
            continue;
          }
          if (hlsBalance < amountWei) {
            addLog(`Account ${accountIndex + 1} - Bridge ${bridgeCount + 1}: Insufficient HLS balance (${ethers.formatUnits(hlsBalance, 18)} HLS)`, "error");
            continue;
          }
          
          await bridge(wallet, amountHLS, wallet.address, destChainId);
          await updateWallets();
        } catch (error) {
          addLog(`Account ${accountIndex + 1} - Bridge ${bridgeCount + 1}: Failed: ${error.message}`, "error");
        }
        
        if (bridgeCount < dailyActivityConfig.bridgeRepetitions - 1 && !shouldStop) {
          const randomDelay = Math.floor(Math.random() * (60000 - 30000 + 1)) + 30000;
          addLog(`Account ${accountIndex + 1} - Waiting ${Math.floor(randomDelay / 1000)} seconds before next bridge...`, "delay");
          await sleep(randomDelay);
        }
      }
      
      if (!shouldStop) {
        const stakeDelay = Math.floor(Math.random() * (15000 - 10000 + 1)) + 10000;
        addLog(`Waiting ${stakeDelay / 1000} seconds before staking...`, "wait");
        await sleep(stakeDelay);
      }
      
      const shuffledValidators = [...availableValidators].sort(() => Math.random() - 0.5);
      
      for (let stakeCount = 0; stakeCount < dailyActivityConfig.stakeRepetitions && !shouldStop; stakeCount++) {
        const validator = shuffledValidators[stakeCount % shuffledValidators.length];
        const amountHLS = (Math.random() * (dailyActivityConfig.maxHlsStake - dailyActivityConfig.minHlsStake) + dailyActivityConfig.minHlsStake).toFixed(4);
        try {
          addLog(`Account ${accountIndex + 1} - Stake ${stakeCount + 1}: Stake ${amountHLS} HLS to ${validator.name}`, "info");
          await stake(wallet, amountHLS, validator.address, validator.name);
          await updateWallets();
        } catch (error) {
          addLog(`Account ${accountIndex + 1} - Stake ${stakeCount + 1}: Failed: ${error.message}`, "error");
        }
        
        if (stakeCount < dailyActivityConfig.stakeRepetitions - 1 && !shouldStop) {
          const randomDelay = Math.floor(Math.random() * (60000 - 30000 + 1)) + 30000;
          addLog(`Account ${accountIndex + 1} - Waiting ${Math.floor(randomDelay / 1000)} seconds before next stake...`, "delay");
          await sleep(randomDelay);
        }
      }
      
      if (accountIndex < privateKeys.length - 1 && !shouldStop) {
        addLog(`Waiting 10 seconds before next account...`, "delay");
        await sleep(10000);
      }
    }
    if (!shouldStop && activeProcesses <= 0) {
      addLog("All accounts processed. Waiting 24 hours for next cycle.", "success");
      dailyActivityInterval = setTimeout(runDailyActivity, 24 * 60 * 60 * 1000);
    }
  } catch (error) {
    addLog(`Daily activity failed: ${error.message}`, "error");
  } finally {
    try {
      if (shouldStop) {
        const stopCheckInterval = setInterval(() => {
          if (activeProcesses <= 0) {
            clearInterval(stopCheckInterval);
            if (dailyActivityInterval) {
              clearTimeout(dailyActivityInterval);
              dailyActivityInterval = null;
              addLog("Cleared daily activity interval.", "info");
            }
            activityRunning = false;
            isCycleRunning = false;
            shouldStop = false;
            hasLoggedSleepInterrupt = false;
            activeProcesses = 0;
            addLog("Daily activity stopped successfully.", "success");
            updateMenu();
            updateStatus();
            safeRender();
          } else {
            addLog(`Waiting for ${activeProcesses} process to complete...`, "info");
          }
        }, 1000);
      } else {
        activityRunning = false;
        isCycleRunning = activeProcesses > 0 || dailyActivityInterval !== null;
        updateMenu();
        updateStatus();
        safeRender();
      }
      nonceTracker = {};
    } catch (finalError) {
      addLog(`Error in runDailyActivity cleanup: ${finalError.message}`, "error");
    }
  }
}

const screen = blessed.screen({
  smartCSR: true,
  title: "HELIOS TESTNET AUTO BOT",
  autoPadding: true,
  fullUnicode: true,
  mouse: true,
  ignoreLocked: ["C-c", "q", "escape"]
});

const headerBox = blessed.box({
  top: 0,
  left: "center",
  width: "100%",
  height: 6,
  tags: true,
  style: { fg: "yellow", bg: "default" }
});

const statusBox = blessed.box({
  left: 0,
  top: 6,
  width: "100%",
  height: 3,
  tags: true,
  border: { type: "line", fg: "cyan" },
  style: { fg: "white", bg: "default", border: { fg: "cyan" } },
  content: "Status: Initializing...",
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  label: chalk.cyan(" Status "),
  wrap: true
});

const walletBox = blessed.list({
  label: " Wallet Information",
  top: 9,
  left: 0,
  width: "40%",
  height: "35%",
  border: { type: "line", fg: "cyan" },
  style: { border: { fg: "cyan" }, fg: "white", bg: "default", item: { fg: "white" } },
  scrollable: true,
  scrollbar: { bg: "cyan", fg: "black" },
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  tags: true,
  keys: true,
  vi: true,
  mouse: true,
  content: "Loading wallet data..."
});

const logBox = blessed.log({
  label: " Transaction Logs",
  top: 9,
  left: "41%",
  width: "60%",
  height: "100%-9",
  border: { type: "line" },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  tags: true,
  scrollbar: { ch: "│", style: { bg: "cyan", fg: "white" }, track: { bg: "gray" } },
  scrollback: 100, 
  smoothScroll: true,
  style: { border: { fg: "magenta" }, bg: "default", fg: "white" },
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  wrap: true,
  focusable: true,
  keys: true
});

const menuBox = blessed.list({
  label: " Menu ",
  top: "44%",
  left: 0,
  width: "40%",
  height: "56%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "red" }, selected: { bg: "magenta", fg: "black" }, item: { fg: "white" } },
  items: isCycleRunning
    ? ["Stop Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
    : ["Start Auto Daily Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"],
  padding: { left: 1, top: 1 }
});

const dailyActivitySubMenu = blessed.list({
  label: " Manual Config Options ",
  top: "44%",
  left: 0,
  width: "40%",
  height: "56%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "blue" },
    selected: { bg: "blue", fg: "black" },
    item: { fg: "white" }
  },
  items: [
    "Set Bridge Repetitions",
    "Set HLS Range For Bridge",
    "Set Stake Repetitions",
    "Set HLS Range For Stake",
    "Back to Main Menu"
  ],
  padding: { left: 1, top: 1 },
  hidden: true
});

const configForm = blessed.form({
  label: " Enter Config Value ",
  top: "center",
  left: "center",
  width: "30%",
  height: "40%",
  keys: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "blue" }
  },
  padding: { left: 1, top: 1 },
  hidden: true
});

const minLabel = blessed.text({
  parent: configForm,
  top: 0,
  left: 1,
  content: "Min HLS:",
  style: { fg: "white" }
});

const maxLabel = blessed.text({
  parent: configForm,
  top: 4,
  left: 1,
  content: "Max HLS:",
  style: { fg: "white" }
});

const configInput = blessed.textbox({
  parent: configForm,
  top: 1,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const configInputMax = blessed.textbox({
  parent: configForm,
  top: 5,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const configSubmitButton = blessed.button({
  parent: configForm,
  top: 9,
  left: "center",
  width: 10,
  height: 3,
  content: "Submit",
  align: "center",
  border: { type: "line" },
  clickable: true,
  keys: true,
  style: {
    fg: "white",
    bg: "blue",
    border: { fg: "white" },
    hover: { bg: "green" },
    focus: { bg: "green", border: { fg: "yellow" } }
  }
});

screen.append(headerBox);
screen.append(statusBox);
screen.append(walletBox);
screen.append(logBox);
screen.append(menuBox);
screen.append(dailyActivitySubMenu);
screen.append(configForm);

let renderQueue = [];
let isRendering = false;
function safeRender() {
  renderQueue.push(true);
  if (isRendering) return;
  isRendering = true;
  setTimeout(() => {
    try {
      if (!isHeaderRendered) {
        figlet.text("NT EXHAUST", { font: "ANSI Shadow" }, (err, data) => {
          if (!err) headerBox.setContent(`{center}{bold}{cyan-fg}${data}{/cyan-fg}{/bold}{/center}`);
          isHeaderRendered = true;
        });
      }
      screen.render();
    } catch (error) {
      addLog(`UI render error: ${error.message}`, "error");
    }
    renderQueue.shift();
    isRendering = false;
    if (renderQueue.length > 0) safeRender();
  }, 100);
}

function adjustLayout() {
  const screenHeight = screen.height || 24;
  const screenWidth = screen.width || 80;
  headerBox.height = Math.max(6, Math.floor(screenHeight * 0.15));
  statusBox.top = headerBox.height;
  statusBox.height = Math.max(3, Math.floor(screenHeight * 0.07));
  walletBox.top = headerBox.height + statusBox.height;
  walletBox.width = Math.floor(screenWidth * 0.4);
  walletBox.height = Math.floor(screenHeight * 0.35);
  logBox.top = headerBox.height + statusBox.height;
  logBox.left = Math.floor(screenWidth * 0.41);
  logBox.width = Math.floor(screenWidth * 0.6);
  logBox.height = screenHeight - (headerBox.height + statusBox.height);
  menuBox.top = headerBox.height + statusBox.height + walletBox.height;
  menuBox.width = Math.floor(screenWidth * 0.4);
  menuBox.height = screenHeight - (headerBox.height + statusBox.height + walletBox.height);

  if (menuBox.top != null) {
    dailyActivitySubMenu.top = menuBox.top;
    dailyActivitySubMenu.width = menuBox.width;
    dailyActivitySubMenu.height = menuBox.height;
    dailyActivitySubMenu.left = menuBox.left;
    configForm.width = Math.floor(screenWidth * 0.3);
    configForm.height = Math.floor(screenHeight * 0.4);
  }

  safeRender();
}

function updateStatus() {
  try {
    const isProcessing = activityRunning || (isCycleRunning && dailyActivityInterval !== null);
    const status = activityRunning
      ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Running")}`
      : isCycleRunning && dailyActivityInterval !== null
      ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Waiting for next cycle")}`
      : chalk.green("Idle");
    const statusText = `Status: ${status} | Active Account: ${getShortAddress(walletInfo.address)} | Total Accounts: ${privateKeys.length} | Auto Bridge: ${dailyActivityConfig.bridgeRepetitions}x | Auto Stake: ${dailyActivityConfig.stakeRepetitions}x | HELIOS AUTO BOT`;
    statusBox.setContent(statusText);
    if (isProcessing) {
      if (blinkCounter % 1 === 0) {
        statusBox.style.border.fg = borderBlinkColors[borderBlinkIndex];
        borderBlinkIndex = (borderBlinkIndex + 1) % borderBlinkColors.length;
      }
      blinkCounter++;
    } else {
      statusBox.style.border.fg = "cyan";
    }
    spinnerIndex = (spinnerIndex + 1) % loadingSpinner.length;
    safeRender();
  } catch (error) {
    addLog(`Status update error: ${error.message}`, "error");
  }
}

async function updateWallets() {
  try {
    const walletData = await updateWalletData();
    const header = `${chalk.bold.cyan("     Address").padEnd(12)}                   ${chalk.bold.cyan("HLS".padEnd(8))}`;
    const separator = chalk.gray("-".repeat(49));
    walletBox.setItems([header, separator, ...walletData]);
    walletBox.select(0);
    safeRender();
  } catch (error) {
    addLog(`Failed to update wallet data: ${error.message}`, "error");
  }
}

function updateLogs() {
  try {
    logBox.add(transactionLogs[transactionLogs.length - 1] || chalk.gray("No logs available."));
    safeRender();
  } catch (error) {
    addLog(`Log update failed: ${error.message}`, "error");
  }
}

function updateMenu() {
  try {
    menuBox.setItems(
      isCycleRunning
        ? ["Stop Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
        : ["Start Auto Daily Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"]
    );
    safeRender();
  } catch (error) {
    addLog(`Menu update failed: ${error.message}`, "error");
  }
}

const statusInterval = setInterval(updateStatus, 100);

logBox.key(["up"], () => {
  if (screen.focused === logBox) {
    logBox.scroll(-1);
    safeRender();
  }
});

logBox.key(["down"], () => {
  if (screen.focused === logBox) {
    logBox.scroll(1);
    safeRender();
  }
});

logBox.on("click", () => {
  screen.focusPush(logBox);
  logBox.style.border.fg = "yellow";
  menuBox.style.border.fg = "red";
  dailyActivitySubMenu.style.border.fg = "blue";
  safeRender();
});

logBox.on("blur", () => {
  logBox.style.border.fg = "magenta";
  safeRender();
});

menuBox.on("select", async (item) => {
  const action = item.getText();
  switch (action) {
    case "Start Auto Daily Activity":
      if (isCycleRunning) {
        addLog("Cycle is still running. Stop the current cycle first.", "error");
      } else {
        await runDailyActivity();
      }
      break;
    case "Stop Activity":
      shouldStop = true;
      if (dailyActivityInterval) {
        clearTimeout(dailyActivityInterval);
        dailyActivityInterval = null;
        addLog("Cleared daily activity interval.", "info");
      }
      addLog("Stopping daily activity. Please wait for ongoing process to complete.", "info");
      safeRender();
      const stopCheckInterval = setInterval(() => {
        if (activeProcesses <= 0) {
          clearInterval(stopCheckInterval);
          activityRunning = false;
          isCycleRunning = false;
          shouldStop = false;
          hasLoggedSleepInterrupt = false;
          activeProcesses = 0;
          updateMenu();
          updateStatus();
          safeRender();
        } else {
          addLog(`Waiting for ${activeProcesses} process(es) to complete...`, "info");
          safeRender();
        }
      }, 1000);
      break;
    case "Set Manual Config":
      menuBox.hide();
      dailyActivitySubMenu.show();
      setTimeout(() => {
        if (dailyActivitySubMenu.visible) {
          screen.focusPush(dailyActivitySubMenu);
          dailyActivitySubMenu.style.border.fg = "yellow";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;
    case "Clear Logs":
      clearTransactionLogs();
      break;
    case "Refresh":
      await updateWallets();
      addLog("Data refreshed.", "success");
      break;
    case "Exit":
      clearInterval(statusInterval);
      process.exit(0);
  }
});

dailyActivitySubMenu.on("select", (item) => {
  const action = item.getText();
  switch (action) {
    case "Set Bridge Repetitions":
      configForm.configType = "bridgeRepetitions";
      configForm.setLabel(" Enter Bridge Repetitions ");
      minLabel.hide();
      maxLabel.hide();
      configInput.setValue(dailyActivityConfig.bridgeRepetitions.toString());
      configInputMax.setValue("");
      configInputMax.hide();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          safeRender();
        }
      }, 100);
      break;
    case "Set HLS Range For Bridge":
      configForm.configType = "hlsRangeBridge";
      configForm.setLabel(" Enter HLS Range for Bridge ");
      minLabel.show();
      maxLabel.show();
      configInput.setValue(dailyActivityConfig.minHlsBridge.toString());
      configInputMax.setValue(dailyActivityConfig.maxHlsBridge.toString());
      configInputMax.show();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          safeRender();
        }
      }, 100);
      break;
    case "Set Stake Repetitions":
      configForm.configType = "stakeRepetitions";
      configForm.setLabel(" Enter Stake Repetitions ");
      minLabel.hide();
      maxLabel.hide();
      configInput.setValue(dailyActivityConfig.stakeRepetitions.toString());
      configInputMax.setValue("");
      configInputMax.hide();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          safeRender();
        }
      }, 100);
      break;
    case "Set HLS Range For Stake":
      configForm.configType = "hlsRangeStake";
      configForm.setLabel(" Enter HLS Range for Stake ");
      minLabel.show();
      maxLabel.show();
      configInput.setValue(dailyActivityConfig.minHlsStake.toString());
      configInputMax.setValue(dailyActivityConfig.maxHlsStake.toString());
      configInputMax.show();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          safeRender();
        }
      }, 100);
      break;
    case "Back to Main Menu":
      dailyActivitySubMenu.hide();
      menuBox.show();
      setTimeout(() => {
        if (menuBox.visible) {
          screen.focusPush(menuBox);
          menuBox.style.border.fg = "cyan";
          dailyActivitySubMenu.style.border.fg = "blue";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;
  }
});

configForm.on("submit", () => {
  const inputValue = configInput.getValue().trim();
  let value, maxValue;
  try {
    value = parseFloat(inputValue);
    if (configForm.configType === "hlsRangeBridge" || configForm.configType === "hlsRangeStake") {
      maxValue = parseFloat(configInputMax.getValue().trim());
      if (isNaN(maxValue) || maxValue <= 0) {
        addLog("Invalid Max HLS value. Please enter a positive number.", "error");
        configInputMax.setValue("");
        screen.focusPush(configInputMax);
        safeRender();
        return;
      }
    }
    if (isNaN(value) || value <= 0) {
      addLog("Invalid input. Please enter a positive number.", "error");
      configInput.setValue("");
      screen.focusPush(configInput);
      safeRender();
      return;
    }
  } catch (error) {
    addLog(`Invalid format: ${error.message}`, "error");
    configInput.setValue("");
    screen.focusPush(configInput);
    safeRender();
    return;
  }

  if (configForm.configType === "bridgeRepetitions") {
    dailyActivityConfig.bridgeRepetitions = Math.floor(value);
    addLog(`Bridge Repetitions set to ${dailyActivityConfig.bridgeRepetitions}`, "success");
  } else if (configForm.configType === "hlsRangeBridge") {
    if (value > maxValue) {
      addLog("Min HLS cannot be greater than Max HLS.", "error");
      configInput.setValue("");
      configInputMax.setValue("");
      screen.focusPush(configInput);
      safeRender();
      return;
    }
    dailyActivityConfig.minHlsBridge = value;
    dailyActivityConfig.maxHlsBridge = maxValue;
    addLog(`HLS Range for Bridge set to ${dailyActivityConfig.minHlsBridge} - ${dailyActivityConfig.maxHlsBridge}`, "success");
  } else if (configForm.configType === "stakeRepetitions") {
    dailyActivityConfig.stakeRepetitions = Math.floor(value);
    addLog(`Stake Repetitions set to ${dailyActivityConfig.stakeRepetitions}`, "success");
  } else if (configForm.configType === "hlsRangeStake") {
    if (value > maxValue) {
      addLog("Min HLS cannot be greater than Max HLS.", "error");
      configInput.setValue("");
      configInputMax.setValue("");
      screen.focusPush(configInput);
      safeRender();
      return;
    }
    dailyActivityConfig.minHlsStake = value;
    dailyActivityConfig.maxHlsStake = maxValue;
    addLog(`HLS Range for Stake set to ${dailyActivityConfig.minHlsStake} - ${dailyActivityConfig.maxHlsStake}`, "success");
  }
  saveConfig();
  updateStatus();

  configForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

configInput.key(["enter"], () => {
  if (configForm.configType === "hlsRangeBridge" || configForm.configType === "hlsRangeStake") {
    screen.focusPush(configInputMax);
  } else {
    configForm.submit();
    screen.focusPush(configSubmitButton);
  }
});

configInputMax.on("submit", () => {
  configForm.submit();
});

configSubmitButton.on("press", () => {
  configForm.submit();
});

configSubmitButton.on("click", () => {
  configForm.submit();
});

configForm.key(["escape"], () => {
  configForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

dailyActivitySubMenu.key(["escape"], () => {
  dailyActivitySubMenu.hide();
  menuBox.show();
  setTimeout(() => {
    if (menuBox.visible) {
      screen.focusPush(menuBox);
      menuBox.style.border.fg = "cyan";
      dailyActivitySubMenu.style.border.fg = "blue";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

screen.key(["escape", "q", "C-c"], () => {
  addLog("Exiting application", "info");
  clearInterval(statusInterval);
  process.exit(0);
});

async function initialize() {
  try {
    loadConfig();
    loadPrivateKeys();
    loadProxies();
    updateStatus();
    await updateWallets();
    updateLogs();
    safeRender();
    menuBox.focus();
  } catch (error) {
    addLog(`Initialization error: ${error.message}`, "error");
  }
}

setTimeout(() => {
  adjustLayout();
  screen.on("resize", adjustLayout);
}, 100);

initialize();
