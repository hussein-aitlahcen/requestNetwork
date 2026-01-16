import { EthereumPrivateKeySignatureProvider } from '@requestnetwork/epk-signature';
import { payBatchProxyRequest } from '@requestnetwork/payment-processor';
import * as RequestNetwork from '@requestnetwork/request-client.js';
import { RequestLogicTypes } from '@requestnetwork/types';
import { Domain } from '@unionlabs/payments';
import { Z_ASSET_REGISTRY } from '@unionlabs/payments/constants/z-asset-registry';
import { Erc20Address, PaymentKey } from '@unionlabs/payments/Domain';
import { DepositAddress } from '@unionlabs/payments/Payment';
import {
  Attestor,
  EvmPublicClient,
  EvmWalletClient,
  Payment,
  Prover,
} from '@unionlabs/payments/promises';
import { Wallet, providers } from 'ethers';
import { Hex, createPublicClient, createWalletClient, http } from 'viem';
import { Address, privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
const ERC20_ABI = [
  {
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];
const ZASSET_ABI = [
  {
    inputs: [{ name: 'amount', type: 'uint256' }],
    name: 'deposit',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'amount', type: 'uint256' }],
    name: 'withdraw',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
];
const ETH_UNIVERSAL_CHAIN_ID = Domain.UniversalChainId.make(`ethereum.1`);
const ETH_LOOPBACK_LIGHTCLIENT_ID = 9;
const ATTESTOR_API_KEY =
  process.env.ATTESTOR_API_KEY ??
  '6af6f8068d38ebf6666b8db98f9b8b42959ab62646764bc290e663f7abb49eea';
const ASSET_ADDRESS = Domain.Erc20Address('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
type PrivateRequestPayment = {
  request: RequestNetwork.Types.IRequestData;
  paymentKey: PaymentKey;
  depositAddress: DepositAddress;
  amount: number;
  beneficiary: RequestNetwork.Types.Identity.IIdentity;
};
const rpc = process.env.RPC!;
const payerIdentity = {
  type: RequestNetwork.Types.Identity.TYPE.ETHEREUM_ADDRESS,
  value: '0x3d2F673B11f62b787faa1ef2871E2408aE22b717',
};
const payer = {
  method: RequestNetwork.Types.Signature.METHOD.ECDSA,
  privateKey: process.env.PRIVATE_KEY!,
};
const payees = [
  {
    payeeIdentity: {
      type: RequestNetwork.Types.Identity.TYPE.ETHEREUM_ADDRESS,
      value: '0x610985EbA8308B40fCC97e7cc6A0ef1aC342Dec7',
    },
    expectedAmount: 1,
  },
  {
    payeeIdentity: {
      type: RequestNetwork.Types.Identity.TYPE.ETHEREUM_ADDRESS,
      value: '0x610985EbA8308B40fCC97e7cc6A0ef1aC342Dec7',
    },
    expectedAmount: 1,
  },
  {
    payeeIdentity: {
      type: RequestNetwork.Types.Identity.TYPE.ETHEREUM_ADDRESS,
      value: '0x3d2F673B11f62b787faa1ef2871E2408aE22b717',
    },
    expectedAmount: 1,
  },
];
const currency: RequestLogicTypes.ICurrency = {
  type: RequestLogicTypes.CURRENCY.ERC20,
  value: '0xF0000101561619d8A61ABd045F47Af4f41Afe62D',
  network: 'mainnet',
};
const signatureProvider = new EthereumPrivateKeySignatureProvider(payer);
const viemWalletClient = createWalletClient({
  account: privateKeyToAccount(payer.privateKey as Hex),
  chain: mainnet,
  transport: http(rpc),
});
const viemPublicClient = createPublicClient({
  chain: mainnet,
  transport: http(rpc),
});
const payments: PrivateRequestPayment[] = [];

// eslint-disable-next-line
(async () => {
  const totalAmount = payees.map((payee) => payee.expectedAmount).reduce((x, y) => x + y);
  console.log('Approving zUSDC to wrap USDC...');
  const approveHash = await viemWalletClient.writeContract({
    address: ASSET_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [Z_ASSET_REGISTRY?.[ETH_UNIVERSAL_CHAIN_ID]?.[ASSET_ADDRESS], totalAmount],
  });
  await viemPublicClient.waitForTransactionReceipt({ hash: approveHash });
  console.log(`Approve: https://etherscan.io/tx/${approveHash}`);
  console.log('Wrapping USDC to zUSDC...');
  const depositHash = await viemWalletClient.writeContract({
    address: Z_ASSET_REGISTRY?.[ETH_UNIVERSAL_CHAIN_ID]?.[ASSET_ADDRESS] as unknown as Address,
    abi: ZASSET_ABI,
    functionName: 'deposit',
    args: [totalAmount],
  });
  await viemPublicClient.waitForTransactionReceipt({ hash: depositHash });
  console.log(`Deposit (wrap): https://etherscan.io/tx/${depositHash}`);
  // mainnet, how to do that properly? batch proxy address
  const proxyAddress = '0x0DD57FFe83a53bCbd657e234B16A3e74fEDb8fBA';
  console.log('Approving batch contract to pay with zUSDC...');
  const approveBatchHash = await viemWalletClient.writeContract({
    address: Z_ASSET_REGISTRY?.[ETH_UNIVERSAL_CHAIN_ID]?.[ASSET_ADDRESS] as unknown as Address,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [proxyAddress, totalAmount],
  });
  await viemPublicClient.waitForTransactionReceipt({ hash: approveBatchHash });
  console.log(`Approve: https://etherscan.io/tx/${approveBatchHash}`);
  const walletClient = await EvmWalletClient.fromViem(viemWalletClient as unknown as any);
  const publicClient = await EvmPublicClient.fromViem(viemPublicClient as unknown as any);
  for (const { payeeIdentity, expectedAmount } of payees) {
    const paymentKey = await Payment.generateKey();
    console.log(`PaymentKey: ${paymentKey}`);
    const depositAddress = await Payment.getDepositAddress({
      paymentKey,
      beneficiaries: [payeeIdentity.value as Erc20Address],
      // Ethereum mainnet
      destinationChainId: ETH_UNIVERSAL_CHAIN_ID,
    });
    const requestInfo: RequestNetwork.Types.IRequestInfo = {
      currency,
      expectedAmount,
      payee: {
        type: RequestNetwork.Types.Identity.TYPE.ETHEREUM_ADDRESS,
        // TODO: fix in sdk, should be unspendableAddress of type Erc20Address
        value: depositAddress.zAssetAddress,
      },
      payer: payerIdentity,
    };
    const paymentNetwork: RequestNetwork.Types.Payment.PaymentNetworkCreateParameters = {
      id: RequestNetwork.Types.Extension.PAYMENT_NETWORK_ID.ERC20_FEE_PROXY_CONTRACT,
      parameters: {
        paymentAddress: depositAddress.zAssetAddress,
        feeAmount: '0',
        feeAddress: payerIdentity.value,
      },
    };
    const requestNetwork = new RequestNetwork.RequestNetwork({
      signatureProvider,
      useMockStorage: true,
    });
    const createParams = {
      paymentNetwork,
      requestInfo,
      signer: payerIdentity,
    };
    createParams.requestInfo.timestamp = RequestNetwork.Utils.getCurrentTimestampInSecond();
    const request = await requestNetwork.createRequest(createParams);
    await request.waitForConfirmation();
    payments.push({
      request: request.getData(),
      paymentKey,
      depositAddress,
      amount: expectedAmount,
      beneficiary: payeeIdentity,
    });
  }
  console.log('Proceeding to payment...');
  const provider = new providers.JsonRpcProvider(rpc);
  const wallet = new Wallet(payer.privateKey, provider);
  const batchVersion = '0.1.0';
  const tx = await payBatchProxyRequest(
    payments.map((payment) => payment.request),
    batchVersion,
    wallet,
    0,
  );
  const receipt = await tx.wait(1);
  console.log(`Payment: https://etherscan.io/tx/${tx.hash}`);
  await publicClient.waitForBlock(BigInt(receipt.blockNumber + 1));
  console.log('Updating light client...');
  const updateRequest = await walletClient.updateLoopbackClient({
    clientId: ETH_LOOPBACK_LIGHTCLIENT_ID,
    height: await publicClient.getLatestBlockNumber(),
    ibcHandlerAddress: Domain.IbcCoreAddress('0xee4ea8d358473f0fcebf0329feed95d56e8c04d7'),
    universalChainId: ETH_UNIVERSAL_CHAIN_ID,
  });
  const [signedRequest] = await walletClient.sign(updateRequest);
  const result = await walletClient.submit(signedRequest);
  await publicClient.waitForTransactionReceipt(result.hash);
  console.log(`Update: https://etherscan.io/tx/${result.hash}`);
  const prover = await Prover.make({
    proverUrl: 'https://prover.payments.union.build',
  });
  const attestor = await Attestor.make({
    baseUrl: 'https://attestor.payments.union.build/functions/v1/attest',
    apiKey: ATTESTOR_API_KEY,
  });
  for (const { paymentKey, depositAddress, amount, beneficiary } of payments) {
    console.log(`Redeeming for ${beneficiary.value}...`);
    const nullifier = await Payment.getNullifier({
      paymentKey,
      destinationChainId: ETH_UNIVERSAL_CHAIN_ID,
    });
    console.log('Generating ZKP...');
    const proof = await Payment.generateProof({
      paymentKey,
      depositAddress,
      nullifier,
      beneficiary: beneficiary.value as unknown as Erc20Address,
      amount: BigInt(amount),
      clientIds: [ETH_LOOPBACK_LIGHTCLIENT_ID],
      selectedClientId: ETH_LOOPBACK_LIGHTCLIENT_ID,
      srcChainId: ETH_UNIVERSAL_CHAIN_ID,
      srcErc20Address: ASSET_ADDRESS,
      dstErc20Address: ASSET_ADDRESS,
      publicClient,
      sourcePublicClient: publicClient,
      destinationPublicClient: publicClient,
      prover,
    });
    console.log('Requesting attestation...');
    const attestation = await attestor.get({
      unspendableAddress: depositAddress.zAssetAddress,
      beneficiary: beneficiary.value as unknown as Erc20Address,
    });
    const redemptionRequest = await Payment.prepareRedemption({
      proof,
      dstErc20Address: ASSET_ADDRESS,
      attestation,
      destinationWalletClient: walletClient,
      universalChainId: ETH_UNIVERSAL_CHAIN_ID,
    });
    console.log('Submitting redemption...');
    const [signedRedemption] = await walletClient.sign(redemptionRequest);
    const submittedRedemption = await walletClient.submit(signedRedemption);
    const receipt = await publicClient.waitForTransactionReceipt(submittedRedemption.hash);
    console.log(`Redemption: https://etherscan.io/tx/${receipt.transactionHash}`);
  }
})();
