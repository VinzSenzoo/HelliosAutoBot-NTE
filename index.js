import blessed from "blessed";
import chalk from "chalk";
import figlet from "figlet";
import { ethers } from "ethers";
import fs from "fs";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

const HELIOS_RPC_URL = "https://testnet1.helioschainlabs.org/";
const HELIOS_CHAIN_ID = 42000;
const HELIOS_ROUTER_ADDRESS = "0x0000000000000000000000000000000000000900";
const STAKE_ROUTER_ADDRESS = "0x0000000000000000000000000000000000000800";
const HLS_TOKEN_ADDRESS = "0xD4949664cD82660AaE99bEdc034a0deA8A0bd517";
const SEPOLIA_CHAIN_ID = 11155111;
const BSC_TESTNET_CHAIN_ID = 97;
const CONFIG_FILE = "config.json";

const availableValidators = [
  { name: "Helios-Unity", address: "0x7e62c5e7Eba41fC8c25e605749C476C0236e0604" },
  { name: "Helios-Peer", address: "0x72a9B3509B19D9Dbc2E0Df71c4A6451e8a3DD705" },
  { name: "Helios-Supra", address: "0xa75a393FF3D17eA7D9c9105d5459769EA3EAEf8D" }
];
const isDebug = false;

const tokenAbi = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)"
];

let walletInfo = {
  address: "N/A",
  balanceHLS: "0.0000",
  activeAccount: "N/A"
};
let transactionLogs = [];
let isActivityRunning = false;
let isScheduled = false;
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
  minHlsBridge: 0.01,
  maxHlsBridge: 0.04,
  stakeRepetitions: 1,
  minHlsStake: 0.01,
  maxHlsStake: 0.03,
  bridgeDelay: 30000,
  stakeDelay: 10000,
  accountDelay: 10000
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, "utf8");
      const config = JSON.parse(data);
      dailyActivityConfig.bridgeRepetitions = Number(config.bridgeRepetitions) || 1;
      dailyActivityConfig.minHlsBridge = Number(config.minHlsBridge) || 0.01;
      dailyActivityConfig.maxHlsBridge = Number(config.maxHlsBridge) || 0.04;
      dailyActivityConfig.stakeRepetitions = Number(config.stakeRepetitions) || 1;
      dailyActivityConfig.minHlsStake = Number(config.minHlsStake) || 0.01;
      dailyActivityConfig.maxHlsStake = Number(config.maxHlsStake) || 0.03;
      dailyActivityConfig.bridgeDelay = Number(config.bridgeDelay) || 30000;
      dailyActivityConfig.stakeDelay = Number(config.stakeDelay) || 10000;
      dailyActivityConfig.accountDelay = Number(config.accountDelay) || 10000;
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

async function makeJsonRpcCall(method, params, rpcUrl) {
  try {
    const id = uuidv4();
    const proxyUrl = proxies[selectedWalletIndex % proxies.length] || null;
    const agent = createAgent(proxyUrl);
    const response = await axios.post(rpcUrl, {
      jsonrpc: "2.0",
      id,
      method,
      params
    }, {
      headers: { "Content-Type": "application/json" },
      httpsAgent: agent
    });
    const data = response.data;
    if (data.error) throw new Error(`RPC Error: ${data.error.message} (code: ${data.error.code})`);
    if (!data.result && data.result !== "") throw new Error("No result in RPC response");
    return data.result;
  } catch (error) {
    addLog(`JSON-RPC call failed (${method}): ${error.message}`, "error");
    throw error;
  }
}

process.on("unhandledRejection", (reason) => {
  addLog(`Unhandled Rejection: ${reason.message || reason}`, "error");
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
    case "error": coloredMessage = chalk.redBright(message); break;
    case "success": coloredMessage = chalk.greenBright(message); break;
    case "wait": coloredMessage = chalk.yellowBright(message); break;
    case "info": coloredMessage = chalk.whiteBright(message); break;
    case "delay": coloredMessage = chalk.cyanBright(message); break;
    case "debug": coloredMessage = chalk.blueBright(message); break;
    default: coloredMessage = chalk.white(message);
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
  if (proxyUrl.startsWith("socks")) return new SocksProxyAgent(proxyUrl);
  return new HttpsProxyAgent(proxyUrl);
}

function getProviderWithProxy(proxyUrl, rpcUrl, chainId) {
  const agent = createAgent(proxyUrl);
  const fetchOptions = agent ? { agent } : {};
  const provider = new ethers.JsonRpcProvider(rpcUrl, { chainId, name: rpcUrl.includes("helios") ? "Helios" : "Sepolia" }, { fetchOptions });
  return provider;
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
      const timeout = setTimeout(resolve, ms);
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
  } finally {
    activeProcesses = Math.max(0, activeProcesses - 1);
  }
}

async function updateWalletData() {
  const walletDataPromises = privateKeys.map(async (privateKey, i) => {
    try {
      const proxyUrl = proxies[i % proxies.length] || null;
      const providerHelios = getProviderWithProxy(proxyUrl, HELIOS_RPC_URL, HELIOS_CHAIN_ID);
      const walletHelios = new ethers.Wallet(privateKey, providerHelios);

      const hlsBalance = await providerHelios.getBalance(walletHelios.address);
      const formattedHLS = Number(ethers.formatUnits(hlsBalance, 18)).toFixed(4);

      const formattedEntry = `${i === selectedWalletIndex ? "→ " : "  "}${chalk.bold.magentaBright(getShortAddress(walletHelios.address))}   ${chalk.bold.cyanBright(formattedHLS.padEnd(8))}`;

      if (i === selectedWalletIndex) {
        walletInfo.address = walletHelios.address;
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

async function bridgeHeliosToSepoliaHLS(wallet, amount) {
  try {
    addLog(`Debug: Starting bridge from Helios to Sepolia for ${amount} HLS`, "debug");
    const amountWei = ethers.parseUnits(amount.toString(), 18);
    const tokenContract = new ethers.Contract(HLS_TOKEN_ADDRESS, tokenAbi, wallet);
    addLog(`Debug: Checking allowance for ${HELIOS_ROUTER_ADDRESS} on Helios`, "debug");
    const allowance = await tokenContract.allowance(wallet.address, HELIOS_ROUTER_ADDRESS);
    addLog(`Debug: Allowance: ${ethers.formatUnits(allowance, 18)} HLS`, "debug");
    if (allowance < amountWei) {
      addLog(`Approving ${amount} HLS on Helios`, "info");
      const approveTx = await tokenContract.approve(HELIOS_ROUTER_ADDRESS, amountWei);
      await approveTx.wait();
      addLog(`Approval HLS on Helios Successfully, Hash: ${getShortHash(approveTx.hash)}`, "success");
    }

    const data = "0x7ae4a8ff" +
      ethers.toBeHex(SEPOLIA_CHAIN_ID).slice(2).padStart(64, '0') +
      "00000000000000000000000000000000000000000000000000000000000000a0" +
      HLS_TOKEN_ADDRESS.toLowerCase().slice(2).padStart(64, '0') +
      ethers.zeroPadValue(ethers.toBeHex(amountWei), 32).slice(2) +
      ethers.toBeHex(ethers.parseUnits("0.5", 18)).slice(2).padStart(64, '0') +
      ethers.toBeHex(wallet.address.length).slice(2).padStart(64, '0') +
      Buffer.from(`0x${wallet.address.toLowerCase().slice(2)}`).toString('hex').padEnd(64, '0');

    const tx = {
      to: HELIOS_ROUTER_ADDRESS,
      data,
      gasLimit: 2000000,
      chainId: HELIOS_CHAIN_ID,
      nonce: await getNextNonce(wallet.provider, wallet.address)
    };
    addLog(`Debug: Sending bridge transaction Helios ⮞ Sepolia: ${JSON.stringify(tx)}`, "debug");
    const sentTx = await wallet.sendTransaction(tx);
    const receipt = await sentTx.wait();
    if (receipt.status === 0) {
      addLog(`Bridge transaction reverted: ${JSON.stringify(receipt)}`, "error");
      throw new Error("Transaction reverted");
    }
    addLog(`Bridge Helios ⮞ Sepolia successfully: ${getShortHash(sentTx.hash)}`, "success");
  } catch (error) {
    addLog(`Bridge Helios ⮞ Sepolia failed: ${error.message}`, "error");
    throw error;
  }
}

async function bridgeHeliosToBSCHLS(wallet, amount) {
  try {
    addLog(`Debug: Starting bridge from Helios to BSC Testnet for ${amount} HLS`, "debug");
    const amountWei = ethers.parseUnits(amount.toString(), 18);
    const tokenContract = new ethers.Contract(HLS_TOKEN_ADDRESS, tokenAbi, wallet);
    addLog(`Debug: Checking allowance for ${HELIOS_ROUTER_ADDRESS} on Helios`, "debug");
    const allowance = await tokenContract.allowance(wallet.address, HELIOS_ROUTER_ADDRESS);
    addLog(`Debug: Allowance: ${ethers.formatUnits(allowance, 18)} HLS`, "debug");
    if (allowance < amountWei) {
      addLog(`Approving ${amount} HLS on Helios`, "info");
      const approveTx = await tokenContract.approve(HELIOS_ROUTER_ADDRESS, amountWei);
      await approveTx.wait();
      addLog(`Approval HLS on Helios Successfully, Hash: ${getShortHash(approveTx.hash)}`, "success");
    }

    const data = "0x7ae4a8ff" +
      ethers.toBeHex(BSC_TESTNET_CHAIN_ID).slice(2).padStart(64, '0') +
      "00000000000000000000000000000000000000000000000000000000000000a0" +
      HLS_TOKEN_ADDRESS.toLowerCase().slice(2).padStart(64, '0') +
      ethers.zeroPadValue(ethers.toBeHex(amountWei), 32).slice(2) +
      ethers.toBeHex(ethers.parseUnits("0.5", 18)).slice(2).padStart(64, '0') +
      ethers.toBeHex(wallet.address.length).slice(2).padStart(64, '0') +
      Buffer.from(`0x${wallet.address.toLowerCase().slice(2)}`).toString('hex').padEnd(64, '0');

    const tx = {
      to: HELIOS_ROUTER_ADDRESS,
      data,
      gasLimit: 2000000,
      chainId: HELIOS_CHAIN_ID,
      nonce: await getNextNonce(wallet.provider, wallet.address)
    };
    addLog(`Debug: Sending bridge transaction Helios ⮞ BSC Testnet: ${JSON.stringify(tx)}`, "debug");
    const sentTx = await wallet.sendTransaction(tx);
    const receipt = await sentTx.wait();
    if (receipt.status === 0) {
      addLog(`Bridge transaction reverted: ${JSON.stringify(receipt)}`, "error");
      throw new Error("Transaction reverted");
    }
    addLog(`Bridge Helios ⮞ BSC Testnet Successfully: ${getShortHash(sentTx.hash)}`, "success");
  } catch (error) {
    addLog(`Bridge Helios ⮞ BSC Testnet failed: ${error.message}`, "error");
    throw error;
  }
}

async function stake(wallet, amount, validatorAddress, validatorName) {
  try {
    if (!ethers.isAddress(wallet.address)) throw new Error(`Invalid wallet address: ${wallet.address}`);
    addLog(`Debug: Building stake transaction for amount ${amount} HLS to validator ${validatorName || validatorAddress}`, "debug");

    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const encodedData = abiCoder.encode(
      ["address", "address", "uint256", "bytes"],
      [wallet.address, validatorAddress, ethers.parseUnits(amount.toString(), 18), ethers.toUtf8Bytes("ahelios")]
    );
    const inputData = "0xf5e56040" + encodedData.slice(2);

    const tx = {
      to: STAKE_ROUTER_ADDRESS,
      data: inputData,
      gasLimit: 2000000,
      chainId: HELIOS_CHAIN_ID,
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
    addLog("Stake Transaction Successfully", "success");
  } catch (error) {
    addLog(`Stake operation failed: ${error.message}`, "error");
    throw error;
  }
}

async function runDailyActivity() {
  if (privateKeys.length === 0) {
    addLog("No valid private keys found.", "error");
    return;
  }
  addLog(`Starting daily activity. Bridge: ${dailyActivityConfig.bridgeRepetitions}x, Stake: ${dailyActivityConfig.stakeRepetitions}x`, "info");
  isActivityRunning = true;
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
      addLog(`Account ${accountIndex + 1}: Using Proxy ${proxyUrl || "none"}`, "info");
      const providerHelios = getProviderWithProxy(proxyUrl, HELIOS_RPC_URL, HELIOS_CHAIN_ID);
      const walletHelios = new ethers.Wallet(privateKeys[accountIndex], providerHelios);
      if (!ethers.isAddress(walletHelios.address)) {
        addLog(`Invalid wallet address for account ${accountIndex + 1}: ${walletHelios.address}`, "error");
        continue;
      }
      addLog(`Processing account ${accountIndex + 1}: ${getShortAddress(walletHelios.address)}`, "wait");

      for (let bridgeCount = 0; bridgeCount < dailyActivityConfig.bridgeRepetitions && !shouldStop; bridgeCount++) {
        const amountHLS = (Math.random() * (dailyActivityConfig.maxHlsBridge - dailyActivityConfig.minHlsBridge) + dailyActivityConfig.minHlsBridge).toFixed(4);
        const direction = bridgeCount % 2 === 0 ? "Helios ⮞ Sepolia" : "Helios ⮞ BSC";
        addLog(`Account ${accountIndex + 1} - Bridge ${bridgeCount + 1}: ${direction} ${amountHLS} HLS`, "info");

        try {
          const tokenContract = new ethers.Contract(HLS_TOKEN_ADDRESS, tokenAbi, providerHelios);
          const balance = await tokenContract.balanceOf(walletHelios.address);
          const balanceFormatted = ethers.formatUnits(balance, 18);
          addLog(`Account ${accountIndex + 1} - Bridge ${bridgeCount + 1}: HLS Balance: ${balanceFormatted}`, "wait");
          if (balance < ethers.parseUnits(amountHLS, 18)) {
            addLog(`Account ${accountIndex + 1} - Bridge ${bridgeCount + 1}: Insufficient HLS balance (${balanceFormatted})`, "error");
            continue;
          }

          if (direction === "Helios ⮞ Sepolia") {
            await bridgeHeliosToSepoliaHLS(walletHelios, amountHLS);
          } else {
            await bridgeHeliosToBSCHLS(walletHelios, amountHLS);
          }
          await updateWallets();
        } catch (error) {
          addLog(`Account ${accountIndex + 1} - Bridge ${bridgeCount + 1}: Failed: ${error.message}`, "error");
        }

        if (bridgeCount < dailyActivityConfig.bridgeRepetitions - 1 && !shouldStop) {
          addLog(`Account ${accountIndex + 1} - Waiting ${dailyActivityConfig.bridgeDelay / 1000} seconds before next bridge...`, "delay");
          await sleep(dailyActivityConfig.bridgeDelay);
        }
      }

      if (!shouldStop) {
        addLog(`Waiting ${dailyActivityConfig.stakeDelay / 1000} seconds before staking...`, "wait");
        await sleep(dailyActivityConfig.stakeDelay);
      }

      const shuffledValidators = [...availableValidators].sort(() => Math.random() - 0.5);
      for (let stakeCount = 0; stakeCount < dailyActivityConfig.stakeRepetitions && !shouldStop; stakeCount++) {
        const validator = shuffledValidators[stakeCount % shuffledValidators.length];
        const amountHLS = (Math.random() * (dailyActivityConfig.maxHlsStake - dailyActivityConfig.minHlsStake) + dailyActivityConfig.minHlsStake).toFixed(4);
        try {
          const hlsBalance = await providerHelios.getBalance(walletHelios.address);
          addLog(`Account ${accountIndex + 1} - Stake ${stakeCount + 1}: HLS Balance: ${ethers.formatUnits(hlsBalance, 18)}`, "wait");
          if (hlsBalance < ethers.parseUnits(amountHLS, 18)) {
            addLog(`Account ${accountIndex + 1} - Stake ${stakeCount + 1}: Insufficient HLS balance (${ethers.formatUnits(hlsBalance, 18)} HLS)`, "error");
            continue;
          }
          addLog(`Account ${accountIndex + 1} - Stake ${stakeCount + 1}: Stake ${amountHLS} HLS to ${validator.name}`, "info");
          await stake(walletHelios, amountHLS, validator.address, validator.name);
          await updateWallets();
        } catch (error) {
          addLog(`Account ${accountIndex + 1} - Stake ${stakeCount + 1}: Failed: ${error.message}`, "error");
        }

        if (stakeCount < dailyActivityConfig.stakeRepetitions - 1 && !shouldStop) {
          addLog(`Account ${accountIndex + 1} - Waiting ${dailyActivityConfig.stakeDelay / 1000} seconds before next stake...`, "delay");
          await sleep(dailyActivityConfig.stakeDelay);
        }
      }

      if (accountIndex < privateKeys.length - 1 && !shouldStop) {
        addLog(`Waiting ${dailyActivityConfig.accountDelay / 1000} seconds before next account...`, "delay");
        await sleep(dailyActivityConfig.accountDelay);
      }
    }
    if (!shouldStop && activeProcesses <= 0) {
      addLog("All accounts processed. Waiting 24 hours for next cycle.", "success");
      dailyActivityInterval = setTimeout(runDailyActivity, 24 * 60 * 60 * 1000);
    }
  } catch (error) {
    addLog(`Daily activity failed: ${error.message}`, "error");
  } finally {
    isActivityRunning = false;
    isScheduled = dailyActivityInterval !== null;
    isCycleRunning = isActivityRunning || isScheduled;
    updateMenu();
    updateStatus();
    safeRender();
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
  label: chalk.cyan(" Status ")
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
  items: ["Start Auto Daily Activity", "Set Manual Config", "Clear Logs", "Refresh", "Exit"],
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
  style: { fg: "white", bg: "default", border: { fg: "blue" }, selected: { bg: "blue", fg: "black" }, item: { fg: "white" } },
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
  style: { fg: "white", bg: "default", border: { fg: "blue" } },
  padding: { left: 1, top: 1 },
  hidden: true
});

const minLabel = blessed.text({
  parent: configForm,
  top: 0,
  left: 1,
  content: "Min Value:",
  style: { fg: "white" }
});

const maxLabel = blessed.text({
  parent: configForm,
  top: 4,
  left: 1,
  content: "Max Value:",
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
  style: { fg: "white", bg: "default", border: { fg: "white" }, focus: { border: { fg: "green" } } }
});

const configInputMax = blessed.textbox({
  parent: configForm,
  top: 5,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "white" }, focus: { border: { fg: "green" } } }
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
  style: { fg: "white", bg: "blue", border: { fg: "white" }, hover: { bg: "green" }, focus: { bg: "green", border: { fg: "yellow" } } }
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
  dailyActivitySubMenu.top = menuBox.top;
  dailyActivitySubMenu.width = menuBox.width;
  dailyActivitySubMenu.height = menuBox.height;
  dailyActivitySubMenu.left = menuBox.left;
  configForm.width = Math.floor(screenWidth * 0.3);
  configForm.height = Math.floor(screenHeight * 0.4);
  safeRender();
}

function updateStatus() {
  try {
    const isProcessing = isActivityRunning || (isScheduled && dailyActivityInterval !== null);
    const status = isActivityRunning
      ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Running")}`
      : isScheduled && dailyActivityInterval !== null
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
    const header = `${chalk.bold.cyan("    Address").padEnd(12)}         ${chalk.bold.cyan("HLS".padEnd(8))}`;
    const separator = chalk.gray("-".repeat(40));
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
    let menuItems = ["Set Manual Config", "Clear Logs", "Refresh", "Exit"];
    if (isActivityRunning) menuItems.unshift("Stop Current Activity");
    if (isScheduled && !isActivityRunning) menuItems.unshift("Cancel Scheduled Activity");
    if (!isActivityRunning && !isScheduled) menuItems.unshift("Start Auto Daily Activity");
    menuBox.setItems(menuItems);
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
        addLog("Cycle is still running. Stop or cancel the current cycle first.", "error");
      } else {
        await runDailyActivity();
      }
      break;
    case "Stop Current Activity":
      shouldStop = true;
      addLog("Stopping current activity. Please wait for ongoing process to complete.", "info");
      const stopCheckInterval = setInterval(() => {
        if (activeProcesses <= 0) {
          clearInterval(stopCheckInterval);
          isActivityRunning = false;
          isCycleRunning = isScheduled;
          shouldStop = false;
          hasLoggedSleepInterrupt = false;
          activeProcesses = 0;
          addLog("Current activity stopped successfully.", "success");
          updateMenu();
          updateStatus();
          safeRender();
        } else {
          addLog(`Waiting for ${activeProcesses} process(es) to complete...`, "info");
          safeRender();
        }
      }, 1000);
      break;
    case "Cancel Scheduled Activity":
      if (dailyActivityInterval) {
        clearTimeout(dailyActivityInterval);
        dailyActivityInterval = null;
        isScheduled = false;
        isCycleRunning = false;
        addLog("Scheduled activity canceled.", "info");
        updateMenu();
        updateStatus();
        safeRender();
      }
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
      addLog("Exiting application", "info");
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
        addLog("Invalid Max value. Please enter a positive number.", "error");
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
