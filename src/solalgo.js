const solanaWeb3 = require("@solana/web3.js");
const { Connection, Keypair, TransactionMessage, VersionedTransaction } = solanaWeb3;
const fetch = require("cross-fetch");
const { Wallet } = require("@project-serum/anchor");
const bs58 = require("bs58");
const fs = require("fs");
const fsp = require("fs").promises;
const dotenv = require("dotenv");
const { Indicators } = require("@ixjb94/indicators");

// Variables for Quote API
/* Default is SOL mint address, but you can use whatever you want */ const MintQuote = ''; // So11111111111111111111111111111111111111112 - SOL
/* Default is Token mint address */ const MintBase = ''; //  - TOKEN
/* Token's pool address(For OHLC fetch) */ const PoolBase = '';
/* DEXes excluded from the rotation */ const ExcludeDexes = 'Whirlpool,Orca V2,Orca V1';
/* Buy size in lamports */ const LamportsBuyAmount = 5000
/* Slippage set for Buy(1 BPS = 0.01%) */ const SlippageInBpsBuy = 50
/* Slippage set for Sell(1 BPS = 0.01%) */ const SlippageInBpsSell = 50
let ema9;
let ema26;
let BuyPrice;
let ConstantPrice;
let SellPercentage;
let SellAmountToken;
let MACDLine;
let SignalLine;
let txid;
let TxError;
let TxErrorSlippage;
let TxSignature;
const options = {method: 'GET', headers: {'X-API-KEY': ''}};
const optionrpc = {
  method: 'POST',
  headers: {accept: 'application/json', 'content-type': 'application/json'},
  body: JSON.stringify({
    id: 1,
    jsonrpc: '2.0',
    method: 'getSignaturesForAddress',
    params: [''] // Wallet address
  })
};

const sleep = (ms) => {
  return new Promise(r => setTimeout(r, ms));
};

function envload() {
	const envFilePath = ".env";
	const defaultEnvContent = `# Please fill in the following variables to use SolAlgo. \nRPC_URL\nPRIVATE_KEY=`;
	try {
		if (!fs.existsSync(envFilePath)) {
			fs.writeFileSync(envFilePath, defaultEnvContent, "utf8");
			console.log(
				".env file created. Fill in your private information, and start SolAlgo again.",
			);
			process.exit(0);
		}
		console.log("Everything is okay. Starting the bot...\n");
	} catch (error) {
		console.error(
			"Error occurred while checking or creating the .env file! ",
			error,
		);
		process.exit(1);
	}
	dotenv.config();
	if (!process.env.PRIVATE_KEY || !process.env.RPC_URL) {
		console.error(
			"Required variables in .env file are missing! Please ensure PRIVATE_KEY and RPC_URL are set.",
		);
		process.exit(1);
	}

	return [
		new Wallet(
			solanaWeb3.Keypair.fromSecretKey(
				bs58.decode(process.env.PRIVATE_KEY),
			),
		),
		process.env.RPC_URL,
	];
}

let [wallet, rpcUrl] = envload();

const connection = new Connection(rpcUrl, "confirmed", {
	commitment: "confirmed",
	confirmTransactionInitialTimeout: 30000,
});

const apiOHLC =
  `https://api.geckoterminal.com/api/v2/networks/solana/pools/${PoolBase}/ohlcv/minute?aggregate=5&limit=1000&currency=usd&token=base`; // 5m

async function fetchData() {
  try {
    const response = await fetch(apiOHLC);
    const data = await response.json();

    const fifthElements = data.data.attributes.ohlcv_list.map(
      (subList) => subList[4],
    );
    fifthElements.reverse();

    return data;
  } catch (error) {
    console.error("Error fetching data:", error);
  }
}

let ClosingList = fetchData();

async function BuyPriceFetcher() {
  const response = await fetch(
`https://public-api.birdeye.so/defi/price?address=${MintBase}`, options
  );
  const price = await response.json();
  BuyPrice = price.data.value;
  // console.log("Buying token amount: " + BuyPrice);
}

async function PriceFetcher() {
  try {
    const response = await fetch(
  `https://public-api.birdeye.so/defi/price?address=${MintBase}`, options
    );
    const price = await response.json();
    ConstantPrice =
      price.data.value;
  } catch (error) {
    console.error("Error fetching price: ", error);
  }
  // console.log(ConstantPrice);
}

function PercentageCalculate() {
  try {
    SellPercentage = (ConstantPrice / BuyPrice) * 100;
  } catch (error) {
    console.error("Error calculating percentage: ", error);
  }
}

function calculateEMA9(closingPrices, period) {
  const k = 2 / (period + 1);
  let sma = 0;

  for (let i = 0; i < period; i++) {
    sma += closingPrices[i];
  }
  sma /= period;

  let ema9 = sma;

  for (let i = period; i < closingPrices.length; i++) {
    ema9 = (closingPrices[i] - ema9) * k + ema9;
  }

  return ema9;
}

function calculateDEMA(closingPrices, period) {
  const k = 2 / (period + 1);

  let ema1 = 0;
  for (let i = 0; i < period; i++) {
    ema1 += closingPrices[i];
  }
  ema1 /= period;

  let ema2 = 0;
  for (let i = 0; i < period; i++) {
    ema2 += ema1;
  }
  ema2 /= period;

  let dema = ema1 * 2 - ema2;

  for (let i = period; i < closingPrices.length; i++) {
    ema1 = (closingPrices[i] - ema1) * k + ema1;
    ema2 = (ema1 - ema2) * k + ema2;
    dema = ema1 * 2 - ema2;
  }

  return dema;
}

let InitiateSwap = false;
let PercentSwapInitiated = false;
let datemillis;
let dateseconds;

async function fetchDataAndCalculateDEMA() {
  try {
    const data = await fetchData();
	datemillis = Date.now();
	dateseconds = datemillis * 1000;

    const fifthElements = data.data.attributes.ohlcv_list.map(
      (subList) => subList[4],
    );
    fifthElements.reverse();
	
	const openPrices = data.data.attributes.ohlcv_list.map(
      (subList) => subList[1],
    );
	openPrices.reverse();
	
	const highPrices = data.data.attributes.ohlcv_list.map(
      (subList) => subList[2],
    );
	highPrices.reverse();
	
	const lowPrices = data.data.attributes.ohlcv_list.map(
      (subList) => subList[3],
    );
	lowPrices.reverse();

    let closingListforEMAList12 = fifthElements.slice(-905, -1); 
	let closingListforEMAList26 = fifthElements.slice(-910, -1); 
	
	PriceFetcher();
	PercentageCalculate();
	
	// let ema12List = calculateEMAList(closingListforEMAList12, 12);
	// let ema26List = calculateEMAList(closingListforEMAList26, 26);
	
	// let SignalEmaCalculation = [];
	
	// for(var i = 0;i<=ema26List.length-1;i++)
    // SignalEmaCalculation.push(ema12List[i] - ema26List[i]);

    // MACD INDICATOR
    // ema9 = calculateEMA9(closingListforEMAList12, 12);
    // ema26 = calculateEMA9(closingListforEMAList26, 26);
	// MACDLine = ema9 - ema26;
	// SignalLine = calculateEMA9(SignalEmaCalculation, 9);

    // console.log('Sell Percentage: ' + SellPercentage);
	// console.log('MACD: ' + MACDLine);
	// console.log('Signal' + SignalLine);
	
	// Double EMA
	let dema4 = calculateDEMA(closingListforEMAList12, 10);
	let dema9 = calculateDEMA(closingListforEMAList26, 18);
	ema4 = calculateEMA9(closingListforEMAList12, 4);
    ema9 = calculateEMA9(closingListforEMAList26, 9);
	// console.log('DEMA10: ' + dema4);
	// console.log('DEMA18: ' + dema9);
	
	// SUPERTREND INDICATOR. Do not use.
	// let ATRList = calculateATR(highPrices, lowPrices, fifthElements, 13);
	// let averagetruerange = ATRList[ATRList.length-1];
	// let supertrendLowerLine = (highPrices[highPrices.length-1] + lowPrices[lowPrices.length-1]) / 2 - (6 * averagetruerange);
	// let supertrendUpperLine = (highPrices[highPrices.length-1] + lowPrices[lowPrices.length-1]) / 2 + (6 * averagetruerange);
    // console.log('ATR: ' + averagetruerange);
	// console.log('SuperTrend Lower: ' + supertrendLowerLine);
	// console.log('SuperTrend Upper: ' + supertrendUpperLine);
	
	// TRUE STRENGTH INDEX
	// let { tsiValues, signalLine } = calculateTSIWithSignal(fifthElements, 13, 25, 7, 13);
	let ta = new Indicators();
    let tsiList = await ta.tsi(fifthElements, 25, 13);
	let tsiSignalList = await ta.ema(tsiList, 13);
	let tsiSignal = tsiSignalList[tsiSignalList.length-2];
	let tsiLine = tsiList[tsiList.length-2]; 
	// console.log(tsiLine);
	// console.log(tsiSignal);
	
	// STOCHASTIC
	let stochList = await ta.stoch(highPrices, lowPrices, fifthElements, 14, 6, 6);
	let stochbaseList = stochList[0]
	let stochsignalList = stochList[1]
	let stochbase = stochbaseList[stochbaseList.length-1];
	let stochsignal = stochsignalList[stochsignalList.length-1];
	console.log('Stochastic base: ' + stochbase);
	console.log('Stochastic signal: ' + stochsignal);
	
	// STOCH RSI. Do not use
	let stochRsiList = await ta.stochrsi(fifthElements, 14);
	let stochRsi = stochRsiList[stochRsiList.length-1];
	let stochRsiSignalList = await ta.sma(stochRsiList, 3);
	let stochRsiSignal = stochRsiSignalList[stochRsiSignalList.length-1];
	// let stochRsiwithMAsmoothTest = await ta.sma(stochRsiList, 3);
	// console.log('Stochastic RSI: ' + stochRsiList);
	// console.log('Stochastic Signal: ' + stochRsiSignal);
	
	// FISHER INDICATOR
	let fisher = await ta.fisher(highPrices, lowPrices, 12);
	// console.log(fisher);
	let fisherbaseList = fisher[0]
	let fishersignalList = fisher[1]
	let fisherbase = fisherbaseList[fisherbaseList.length-1];
	let fishersignal = fishersignalList[fishersignalList.length-1]; 
	// let fishersignalListEma = await ta.ema(fisherbaseList, 9);
	// let fishersignalema = fishersignalListEma[fishersignalListEma.length-1];
	// console.log('Fisher base from indicators: ' + fisherbase);
	// console.log('Fisher signal from indicators: ' + fishersignal);
	// console.log('Fisher signal from Technical Indicators EMA: ' + fishersignalema);
	
   if (SellPercentage >= 110) {
		SellExecute();
		console.log('---------------------------'); // For logging purposes. You can use /n if you want
		console.log('Timestamp: ' + dateseconds);
		console.log("Maximum percentage profit exceeded! Swapping...");
		console.log('Expected profit percent: ' + SellPercentage);
		console.log('---------------------------'); // For logging purposes. You can use /n if you want
		PercentSwapInitiated = true;
		BuyPrice = 'This text unassigns the value of the variable';
	}
	
	if (SellPercentage <= 95) {
	    // SellExecute();
		console.log('Timestamp: ' + dateseconds);
		console.log("Minimum percentage loss exceeded! Swapping...");
		console.log('Expected loss percent: ' + SellPercentage);
		PercentSwapInitiated = true;
		BuyPrice = 'This text unassigns the value of the variable';
	}

    if (stochbase > stochsignal && !InitiateSwap/* !PercentSwapInitiated */) {
    // Buy Initializer
	console.log('---------------------------'); // For logging purposes. You can use /n if you want
	console.log('Timestamp: ' + dateseconds);
    console.log("Buy Signal Triggered");
	console.log('---------------------------'); // For logging purposes. You can use /n if you want
    BuyExecute();
    InitiateSwap = true;
} 

    if ((stochbase < stochsignal && InitiateSwap && PercentSwapInitiated)|| (stochbase < stochsignal && InitiateSwap & !PercentSwapInitiated)) {
    // Sell Initializer
	console.log('---------------------------'); // For logging purposes. You can use /n if you want
	console.log('Timestamp: ' + dateseconds);
    console.log("Sell Signal Triggered. Profit/Loss: " + SellPercentage);
	console.log('---------------------------'); // For logging purposes. You can use /n if you want
    SellExecute();
    InitiateSwap = false;
    PercentSwapInitiated = false;
	BuyPrice = 'This text unassigns the value of the variable';
}

  } catch (error) {
    console.error("Error fetching and calculating data:", error);
  } finally {
    setTimeout(fetchDataAndCalculateDEMA, 30000);
  }
}

async function TxErrorChecker() {
	try {
  const response = await fetch(
'Your rpc address here', optionsrpc
  );
  const data = await response.json();
  // TxError = data.result.data[0].err;
  TxSignature = data.result[0].signature;
  TxError = data.result[0].err;
  TxErrorSlippage = data.result[0].err.InstructionError[1].Custom;
	} catch (error) {
		// console.log('Testing the TxErrorSlippage variable error now.');
    } finally {
    setTimeout(TxErrorChecker, 3000);
    }
    // console.log(TxError);
	// console.log(TxSignature);
	// console.log(TxErrorSlippage);
}

/*async function GetTransactionChecker() {
  try {
    const response = await fetch('Your rpc address here', optionsrpc);
    const data = await response.json();
    console.log(data);
  } catch (error) {
    console.error('Error:', error);
  }
}
*/

fetchDataAndCalculateDEMA(); // TechIndicators calculation + Swap decisions
TxErrorChecker(); // Slippage Error Checker. Also retries txs. Can be done via txs simulations but I have a problem doing it.

async function BuyExecute() {
	try {
const quoteResponse = await (
  await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${MintQuote}\&outputMint=${MintBase}\&amount=${LamportsBuyAmount}\&slippageBps=${SlippageInBpsBuy}\&excludeDexes=${ExcludeDexes}`)
).json();
SellAmountToken = quoteResponse.otherAmountThreshold;

const { swapTransaction } = await (
  await fetch('https://quote-api.jup.ag/v6/swap', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      // quoteResponse from /quote api
      quoteResponse,
      // user public key to be used for the swap
      userPublicKey: wallet.publicKey.toString(),
      // auto wrap and unwrap SOL. default is true
      wrapAndUnwrapSol: true,
	  onlyDirectRoutes: true,
      dynamicComputeUnitLimit: true,
	  prioritizationFeeLamports: 5000 // Change desired fee in lamports here
    })
  })
).json();

const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
var transaction = VersionedTransaction.deserialize(swapTransactionBuf);
transaction.sign([wallet.payer]);
// console.log('Signing the transaction...');
const rawTransaction = transaction.serialize();
let blockheight = await connection.getBlockHeight();
const blockhashResponse = await connection.getLatestBlockhashAndContext();
const lastValidBlockHeight = blockheight + 500;
// console.log('Transaction Signature Recieved.');
BuyPriceFetcher();
while (blockheight < lastValidBlockHeight) { 
let txidbuy = await connection.sendRawTransaction(rawTransaction, {
  skipPreflight: true
  // Commitment: 'processed'
  // maxRetries: 5
});
await sleep(1000);
blockheight = await connection.getBlockHeight();
// console.log(txidbuy);
// console.log(blockheight);

      if (TxError !== null && txidbuy === TxSignature && TxErrorSlippage === 6001) {
		  console.log("Slippage error detected! Retrying the swap!");
		  txidbuy = "UNASSIGNED";
		  TxErrorSlippage = 'UNASSIGNED';
		  BuyExecute();
		  break;
	  }

      if (TxError === null && txidbuy === TxSignature) {
		console.log("No slippage error detected. Buy initiated successfully!");
		txidbuy = "UNASSIGNED";
		break;
	  }

   }
} catch(error) {
	console.error(error);
	// if (error.errno = "ETIMEDOUT") { 
		// BuyExecute();
	// }
	// await sleep(3000);
	console.log("Error encountered!");
	// BuyExecute();
   }
}

async function SellExecute() {
	try {
console.log("Token amount to sell: " + SellAmountToken);
const quoteResponse = await (
  await fetch(`https://quote-api.jup.ag/v6/quote?inputMint=${MintBase}\&outputMint=${MintQuote}\&amount=${SellAmountToken}\&slippageBps=${SlippageInBpsSell}\&excludeDexes=${ExcludeDexes}`) 
).json();

const { swapTransaction } = await (
  await fetch('https://quote-api.jup.ag/v6/swap', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      // quoteResponse from /quote api
      quoteResponse,
      // user public key to be used for the swap
      userPublicKey: wallet.publicKey.toString(),
      // auto wrap and unwrap SOL. default is true
      wrapAndUnwrapSol: true,
	  onlyDirectRoutes: true,
      dynamicComputeUnitLimit: true,
	  prioritizationFeeLamports: 5000 // Change desired fee in lamports here
    })
  })
).json();

const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
var transaction = VersionedTransaction.deserialize(swapTransactionBuf);
transaction.sign([wallet.payer]);
// console.log('Signing the transaction...');
const rawTransaction = transaction.serialize();
let blockheight = await connection.getBlockHeight();
const blockhashResponse = await connection.getLatestBlockhashAndContext();
const lastValidBlockHeight = blockheight + 500;
// console.log('Transaction Signature Recieved.');
while (blockheight < lastValidBlockHeight) {
let txidsell = await connection.sendRawTransaction(rawTransaction, {
  skipPreflight: true
  // maxRetries: 5
});
await sleep(1000);
blockheight = await connection.getBlockHeight();
// console.log(blockheight);
// console.log(lastValidBlockHeight);

   if (TxError !== null && txidsell === TxSignature && TxErrorSlippage === 6001) {
		  console.log("Slippage error detected! Retrying the swap!");
		  txidsell = "UNASSIGNED";
		  TxErrorSlippage = 'UNASSIGNED';
		  SellExecute();
		  break;
	  }

      if (TxError === null && txidsell === TxSignature) {
		console.log("No slippage error detected. Sell initiated successfully!");
		txidsell = "UNASSIGNED";
		break;
	  }

   }
   
} catch(error) {
	console.error(error);
	// await sleep(3000);
	console.log("Error encountered!");
	// SellExecute();
   }
}