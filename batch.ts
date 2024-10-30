import {
  Transaction,
  script,
  Psbt,
  initEccLib,
  networks,
  Signer as BTCSigner,
  payments,
  opcodes,
} from "bitcoinjs-lib";
import { Taptree } from "bitcoinjs-lib/src/types";
import { ECPairFactory, ECPairAPI } from "ecpair";
import ecc from "@bitcoinerlab/secp256k1";
import axios, { AxiosResponse } from "axios";
import networkConfig from "config/network.config";
import { WIFWallet } from 'utils/WIFWallet';
import cbor from 'cbor';
import { getTxStatus, initMempoolSocket } from "utils/mempoolSocket";
import { MEMPOOLAPI_URL } from "config/config";

const network = networks.testnet;

interface IUTXO {
  txid: string;
  vout: number;
  status: {
    confirmed: boolean;
    block_height: number;
    block_hash: string;
    block_time: number;
  };
  value: number;
}



initEccLib(ecc as any);
const ECPair: ECPairAPI = ECPairFactory(ecc);

const privateKey: string = process.env.PRIVATE_KEY as string;
const networkType: string = networkConfig.networkType;
const wallet = new WIFWallet({ networkType: networkType, privateKey: privateKey });
export const SIGNATURE_SIZE = 126;

const txhash: string = 'd9b95d549219eebcd1be0360f41c7164c4ad040b716475630154f08263ab2fdf';
const txidBuffer = Buffer.from(txhash, 'hex');
const inscriptionBuffer = txidBuffer.reverse();
const memeType: string = 'text/html;charset=utf-8';


const numberOfInscriptions = 2;  


const pointerBuffers: Buffer[] = Array.from({ length: numberOfInscriptions }, (_, i) => {
  const pointerValue: number = 546 * (i + 1); 
  return Buffer.from(pointerValue.toString(16).padStart(4, '0'), 'hex').reverse();
});

const metaProtocol: Buffer = Buffer.concat([Buffer.from("parcel.bitmap", "utf8")]);
const receiveAddress: string = 'tb1pwc08hjtg4nkaj390u7djryft2z3l4lea4zvepqnpj2adsr4ujzcs3nzcpc';

const metadata = {
  'type': 'Bitmap',
  'description': 'Bitmap Community Parent Ordinal',
};

const metadataBuffer = cbor.encode(metadata);
const contentBuffer = (content: string) => Buffer.from(content, 'utf8');

const contentBufferData: Buffer = contentBuffer(`
<!DOCTYPE html>
<html lang="en"> 
<body style="margin:0; padding:0">
    <canvas id="canvas" style="width:100%; height:auto;" width="2500" height="2500"></canvas>
<script>
       function draw(t,e){
    let n=t.getContext("2d"),
    o=[];
    let a=0;
    e.forEach(t=>{
    let l=new Image;
    l.src=t,l.onload=()=>{
        (a+=1)===e.length&&function t(){
            for(let e=0;e<o.length;e++)n.drawImage(o[e],0,0,2500,2500)}()},o.push(l)})}
 draw(document.getElementById('canvas'), [
            "/content/7cc1561d65c7986d8350af3fd00c29e63628034c220a8c572615c2672cfc5d5ei0",
            "/content/feb371e5b315cdbbfdfb262ae70c3b8409e2fdd39aeb7b3c44f98edbf109d959i0",
            "/content/a86c9b7da5080c0b64a1c9f583d89f30bfcf91b246865b82668c896de6edc4d2i0",
            "/content/df5252f52d13eb6f3ff5d76854343415efe6090924bbac47901038fe4ce1f9e3i0"
        ]);
    </script>
</body>
</html>
`);


const splitBuffer = (buffer: Buffer, chunkSize: number) => {
  let chunks = [];
  for (let i = 0; i < buffer.length; i += chunkSize) {
    const chunk = buffer.subarray(i, i + chunkSize);
    chunks.push(chunk);
  }
  return chunks;
};

const contentBufferArray: Array<Buffer> = splitBuffer(contentBufferData, 500);

export function createChildInscriptionTapScript(index: number): Array<Buffer> {
  const keyPair = wallet.ecPair;
  let childOrdinalStacks: any = [
    toXOnly(keyPair.publicKey),
    opcodes.OP_CHECKSIG,
    opcodes.OP_FALSE,
    opcodes.OP_IF,
    Buffer.from("ord", "utf8"),
    1,
    1,
    Buffer.concat([Buffer.from(memeType, "utf8")]),
    1,
    2,
    pointerBuffers[index], 
    1,
    3,
    inscriptionBuffer,
    1,
    5,
    metadataBuffer,
    1,
    7,
    metaProtocol,
    opcodes.OP_0,
  ];

  contentBufferArray.forEach(item => {
    childOrdinalStacks.push(item);
  });

  childOrdinalStacks.push(opcodes.OP_ENDIF);
  return childOrdinalStacks;
}

async function childInscribe() {
  await initMempoolSocket();
  const keyPair = wallet.ecPair;
  
  let psbtList = [];

  for (let i = 0; i < numberOfInscriptions; i++) {
    const childOrdinalStack = createChildInscriptionTapScript(i);
    const ordinal_script = script.compile(childOrdinalStack);

    const scriptTree: Taptree = { output: ordinal_script };
    const redeem = { output: ordinal_script, redeemVersion: 192 };

    const ordinal_p2tr = payments.p2tr({
      internalPubkey: toXOnly(keyPair.publicKey),
      network,
      scriptTree,
      redeem,
    });

    const address = ordinal_p2tr.address ?? "";
    console.log("send coin to address", address);

    if (!address) {
      console.log("Cannot Get Inscription Address");
      return;
    }

    const txVirtualSizeOfInscription = await dummyPsbtToInscribe(address, redeem, ordinal_p2tr);
    const feeRate = await getFeeRate() + 2000;

    const inscriptionFee = txVirtualSizeOfInscription * feeRate;
    console.log(`Inscription Fee for ${i + 1}:`, inscriptionFee);
    
    let virtualTempSize1 = 1000;

    const txVirtualSizeOfBtc = await dummyPsbtToSendBtc(virtualTempSize1 * feeRate, address)
    const sendFee = txVirtualSizeOfBtc * feeRate
    console.log('txVirtualSizeOfBtc===>', txVirtualSizeOfBtc);
    console.log("sendBtcFee===>", sendFee);

    psbtList.push({ ordinal_p2tr, address, redeem, inscriptionFee });

    const amountToSendBTC = await sendBTC(inscriptionFee + sendFee + 546, address);
    await waitForConfirmation(amountToSendBTC);
  }

  const psbt = new Psbt({ network });
  for (let i = 0; i < psbtList.length; i++) {
    const { ordinal_p2tr, address, redeem } = psbtList[i];

    const utxos = await waitUntilUTXO(address);
    psbt.addInput({
      hash: utxos[0].txid,
      index: utxos[0].vout,
      tapInternalKey: toXOnly(keyPair.publicKey),
      witnessUtxo: { value: utxos[0].value, script: ordinal_p2tr.output! },
      tapLeafScript: [{
        leafVersion: redeem.redeemVersion,
        script: redeem.output,
        controlBlock: ordinal_p2tr.witness![ordinal_p2tr.witness!.length - 1],
      }],
    });

    psbt.addOutput({
      address: receiveAddress,
      value: 546,
    });
  }

  await signAndSend(keyPair, psbt);
}

async function dummyPsbtToInscribe(address: string, redeem: any, ordinal_p2tr: any) {
  const utxos = [{
    txid: "d516c9d358eb0af6dcbe2ede3a48138e14db30df00d51e2cef216a34b70e1c69",
    vout: 1,
    value: 56662,
  }];

  const psbt = new Psbt({ network });
  psbt.addInput({
    hash: utxos[0].txid,
    index: utxos[0].vout,
    tapInternalKey: toXOnly(wallet.ecPair.publicKey),
    witnessUtxo: { value: utxos[0].value, script: wallet.output! },
    tapLeafScript: [{
      leafVersion: redeem.redeemVersion,
      script: redeem.output,
      controlBlock: ordinal_p2tr.witness![ordinal_p2tr.witness!.length - 1],
    }],
  });


    psbt.addOutput({
      address: address,
      value: 546, 
    });
  

  wallet.signPsbt(psbt, wallet.ecPair);
  const txVirtualSize = psbt.extractTransaction(true).virtualSize();
  return txVirtualSize;
}

async function dummyPsbtToSendBtc(amount: number, targetAddress: string) {
  const tempUtxoList = [];
  let btcTotalAmount = 0;
  const psbt = new Psbt({ network });
  const feeRate = await getFeeRate();

  psbt.addOutput({
    address: targetAddress,
    value: amount,
  });

  const fee = calculateTxFee(psbt, feeRate);
  const btcUtxo = await waitUntilUTXO(wallet.address);
  for (const utxoInfo of btcUtxo) {
    if (utxoInfo.value > 1000 && btcTotalAmount < fee + amount) {
      tempUtxoList.push(`${utxoInfo.txid}i${utxoInfo.vout}`);
      btcTotalAmount += utxoInfo.value;
      psbt.addInput({
        hash: utxoInfo.txid,
        index: utxoInfo.vout,
        witnessUtxo: {
          value: utxoInfo.value,
          script: wallet.output,
        },
        tapInternalKey: Buffer.from(wallet.publicKey, "hex").slice(1, 33),
      });
    }
  }

  if (btcTotalAmount < fee + amount) {
    throw new Error("Not enough BTC in UTXOs for the transaction.");
  }

  if (btcTotalAmount - amount - fee > 546) {
    psbt.addOutput({
      address: wallet.address, 
      value: btcTotalAmount - amount - fee,
    });
  }
  wallet.signPsbt(psbt, wallet.ecPair);
  const txVirtualSize = psbt.extractTransaction(true).virtualSize();
  return txVirtualSize;
}


export async function getFeeRate() {
  const url = `${MEMPOOLAPI_URL}/v1/fees/recommended`;
  try {
    const response = await axios.get(url);
    const fees = response.data;
    console.log("feerate==>", fees.fastestFee);
    return fees.fastestFee;
  } catch (error) {
    console.error('Error fetching fee rate:', error);
  }
}

export const calculateTxFee = (psbt: Psbt, feeRate: number) => {
  const tx = new Transaction();

  for (const txInput of psbt.txInputs) {
    tx.addInput(txInput.hash, txInput.index, txInput.sequence);
    tx.setWitness(txInput.index, [Buffer.alloc(SIGNATURE_SIZE)]);
  }

  for (const txOutput of psbt.txOutputs) {
    tx.addOutput(txOutput.script, txOutput.value);
  }

  return tx.virtualSize() * feeRate;
};

const utxoList: string[] = [];

export async function sendBTC(amount: number, targetAddress: string) {
  try {
    const tempUtxoList = [];
    const btcUtxo = await waitUntilUTXO(wallet.address);
    let btcTotalAmount = 0;
    const psbt = new Psbt({ network });
    const feeRate = await getFeeRate() + 100;

    psbt.addOutput({
      address: targetAddress,
      value: amount,
    });

    const fee = calculateTxFee(psbt, feeRate);

    for (const utxoInfo of btcUtxo) {
      if (utxoInfo.value > 1000 && btcTotalAmount < fee + amount && !utxoList.includes(`${utxoInfo.txid}i${utxoInfo.vout}`)) {
        tempUtxoList.push(`${utxoInfo.txid}i${utxoInfo.vout}`);
        btcTotalAmount += utxoInfo.value;
        psbt.addInput({
          hash: utxoInfo.txid,
          index: utxoInfo.vout,
          witnessUtxo: {
            value: utxoInfo.value,
            script: wallet.output,
          },
          tapInternalKey: Buffer.from(wallet.publicKey, "hex").slice(
            1,
            33
          ),
        });
      }
    }

    if (btcTotalAmount < fee + amount) {
      throw new Error("Insufficient funds in UTXOs.");
    }

    if (btcTotalAmount - amount - fee > 546) {
      psbt.addOutput({
        address: wallet.address,
        value: btcTotalAmount - amount - fee,
      });
    }
    wallet.signPsbt(psbt, wallet.ecPair);
    const tx = psbt.extractTransaction();
    const txHex = tx.toHex();
    console.log("Transferred BTC successfully");
    const txId = await broadcast(txHex);
    console.log("BTC sent with transaction ID:", txId);
    return txId;
  } catch (error) {
    throw new Error(error as string);
  }
}

export async function waitForConfirmation(txId: string) {
  let confirmed = false;
  while (!confirmed) {
    await new Promise(resolve => setTimeout(resolve, 10000));

    const status = await getTxStatus(txId);
    console.log(`Checking status for transaction ${txId}:`, status);
    if (status.confirmed) {
      console.log(`Transaction ${txId} confirmed at block height ${status.blockHeight}`);
      confirmed = true;
    }
  }
}

export async function signAndSend(
  keypair: BTCSigner,
  psbt: Psbt,
) {
  psbt.signInput(0, keypair);
  psbt.finalizeAllInputs();
  const tx = psbt.extractTransaction();
  console.log("Transaction Hex:", tx.toHex());
  const txid = await broadcast(tx.toHex());
  console.log(`Success! Txid is ${txid}`);
}

export async function waitUntilUTXO(address: string) {
  return new Promise<IUTXO[]>((resolve, reject) => {
    let intervalId: any;
    const checkForUtxo = async () => {
      try {
        const response: AxiosResponse<string> = await blockstream.get(`/address/${address}/utxo`);
        const data: IUTXO[] = response.data ? JSON.parse(response.data) : undefined;
        console.log("UTXO data:", data);
        if (data.length > 0) {
          resolve(data);
          clearInterval(intervalId);
        }
      } catch (error) {
        reject(error);
        clearInterval(intervalId);
      }
    };
    intervalId = setInterval(checkForUtxo, 4000);
  });
}

const blockstream = new axios.Axios({
  baseURL: `https://mempool.space/testnet/api`,
});

export async function broadcast(txHex: string) {
  const response: AxiosResponse<string> = await blockstream.post("/tx", txHex);
  return response.data;
}

export function toXOnly(pubkey: Buffer): Buffer {
  return pubkey.subarray(1, 33);
}

// Trigger the inscription process
childInscribe().catch(err => console.error(err));
