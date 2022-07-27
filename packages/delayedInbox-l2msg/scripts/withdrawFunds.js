const { providers, Wallet } = require('ethers')
const hre = require('hardhat')
const ethers = require('ethers')
const { arbLog, requireEnvVariables } = require('arb-shared-dependencies')
requireEnvVariables(['DEVNET_PRIVKEY', 'L2RPC', 'L1RPC', 'INBOX_ADDR'])

/**
 * Set up: instantiate L1 / L2 wallets connected to providers
 */
const walletPrivateKey = process.env.DEVNET_PRIVKEY

const L2MSG_signedTx = 4

const l1Provider = new providers.JsonRpcProvider(process.env.L1RPC)
const l2Provider = new providers.JsonRpcProvider(process.env.L2RPC)

const l1Wallet = new Wallet(walletPrivateKey, l1Provider)
const l2Wallet = new Wallet(walletPrivateKey, l2Provider)


const main = async () => {
    await arbLog('DelayedInbox withdraw funds from l2 (L2MSG_signedTx)')

    /**
     * Here we have a arbsys abi to withdraw our funds; we'll be setting it by sending it as a message from delayed inbox!!!
     */

    const ArbsysWithdrawABI = ['function withdrawEth(address destination) external payable returns (uint256)']
    
    const arbsysIface = new ethers.utils.Interface(ArbsysWithdrawABI)
    const calldatal2 = arbsysIface.encodeFunctionData('withdrawEth', [l1Wallet.address])
    const ARBSYS = "0x0000000000000000000000000000000000000064"
    

    /**
     * Encode the l2's signed tx so this tx can be executed on l2
     */
    const l2GasPrice = await l2Provider.getGasPrice()

    let transactionl2Request = {
        data: calldatal2,
        to: ARBSYS,
        nonce: await l2Wallet.getTransactionCount(),
        value: 1, // 1 is needed because if we set 0 will affect the gas estimate
        gasPrice: l2GasPrice,
        chainId: (await l2Provider.getNetwork()).chainId,
        from: l2Wallet.address
    }
    let l2GasLimit
    try {
        l2GasLimit = await l2Provider.estimateGas(transactionl2Request)
    } catch {
        console.log("execution failed (estimate gas failed), try check your account's balance?")
        return
    }
    
    
    transactionl2Request.gasLimit = l2GasLimit

    const l2Balance = await l2Provider.getBalance(l2Wallet.address)

    /**
     * We need to check if the sender has enough funds on l2 to pay the gas fee, if have enough funds, the get the other part funds to withdraw.
     */
    if(l2Balance.lt(l2GasPrice.mul(l2GasLimit))) {
        console.log("You l2 balance is not enough to pay the gas fee, please bridge some ethers to l2.")
        return
    } else {
        transactionl2Request.value = l2Balance.sub(l2GasPrice.mul(l2GasLimit))
    }

    /**
     * We need extract l2's tx hash first so we can check if this tx executed on l2 later.
     */
    const l2SignedTx = await l2Wallet.signTransaction(transactionl2Request)

    const l2Txhash = ethers.utils.parseTransaction(l2SignedTx).hash

    /**
     * Pack the message data to parse to delayed inbox
     */
    const sendData = ethers.utils.solidityPack(["uint8","bytes"],[ethers.utils.hexlify(L2MSG_signedTx),l2SignedTx])
    console.log("Now we get the send data: " + sendData)
    
    /**
     * Process the l1 delayed inbox tx, to process it, we need to have delayed inbox's abi and use it to encode the
     * function call data. After that, we send this tx directly to delayed inbox.
     */
     const ABI = ['function sendL2Message(bytes calldata messageData) external returns(uint256)']
     const iface = new ethers.utils.Interface(ABI)
     const calldatal1 = iface.encodeFunctionData('sendL2Message', [sendData])
     const l1GasPrice = await l1Provider.getGasPrice()

     let transactionl1Request = {
        data: calldatal1,
        to: process.env.INBOX_ADDR,
        nonce: await l1Wallet.getTransactionCount(),
        value: 0,
        gasPrice: l1GasPrice,
        chainId: (await l1Provider.getNetwork()).chainId,
        from: l1Wallet.address
    }

    const l1GasLimit = await l1Provider.estimateGas(transactionl1Request)

    transactionl1Request.gasLimit = l1GasLimit

    const resultsL1 = await l1Wallet.sendTransaction(transactionl1Request)


    
    const inboxRec = await resultsL1.wait()

    console.log(
        `Withdraw txn initiated on L1! 🙌 ${inboxRec.transactionHash}`
    )

    /**
     * Now we successfully send the tx to l1 delayed inbox, then we need to wait the tx executed on l2
     */
    console.log(
        `Now we need to wait tx: ${l2Txhash} to be included on l2 (may take 5 minutes, if longer than 20 minutes, you can use sdk to force include) ....... `
    )

    const l2TxReceipt = await l2Provider.waitForTransaction(l2Txhash)

    
    
    const status = l2TxReceipt.status
    if(status == true) {
        console.log(
            `L2 txn executed!!! 🥳 , you can go to https://bridge.arbitrum.io/ to withdraw your funds after challenge period!`
        )
    } else {
        console.log(
            `L2 txn failed, see if your gas is enough?`
        )
        return
    }
}

main()
.then(() => process.exit(0))
.catch(error => {
    console.error(error)
    process.exit(1)
})