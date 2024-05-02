import {
  Contract,
  BigNumber,
  Event,
  EventSearchConfig,
  paginatedEventQuery,
  Signer,
  Provider,
  ZERO_ADDRESS,
} from "../../../utils";
import { CONTRACT_ADDRESSES } from "../../../common";
import { BridgeTransactionDetails, OpStackBridge } from "./OpStackBridgeInterface";
import { matchL2EthDepositAndWrapEvents } from "../utils";

export class WethBridge implements OpStackBridge {
  private readonly l1Bridge: Contract;
  private readonly l2Bridge: Contract;
  private readonly atomicDepositor: Contract;
  private readonly l2Weth: Contract;

  constructor(
    private l2chainId: number,
    readonly hubChainId: number,
    l1Signer: Signer,
    l2SignerOrProvider: Signer | Provider
  ) {
    const { address: l1Address, abi: l1Abi } = CONTRACT_ADDRESSES[hubChainId][`ovmStandardBridge_${l2chainId}`];
    this.l1Bridge = new Contract(l1Address, l1Abi, l1Signer);

    const { address: l2Address, abi: l2Abi } = CONTRACT_ADDRESSES[l2chainId].ovmStandardBridge;
    this.l2Bridge = new Contract(l2Address, l2Abi, l2SignerOrProvider);

    const { address: atomicDepositorAddress, abi: atomicDepositorAbi } = CONTRACT_ADDRESSES[hubChainId].atomicDepositor;
    this.atomicDepositor = new Contract(atomicDepositorAddress, atomicDepositorAbi, l1Signer);

    const { address: l2WethAddress, abi: l2WethAbi } = CONTRACT_ADDRESSES[l2chainId].weth;
    this.l2Weth = new Contract(l2WethAddress, l2WethAbi, l2SignerOrProvider);
  }

  get l1Gateway(): string {
    return this.atomicDepositor.address;
  }

  constructL1ToL2Txn(
    toAddress: string,
    l1Token: string,
    l2Token: string,
    amount: BigNumber,
    l2Gas: number
  ): BridgeTransactionDetails {
    return {
      contract: this.atomicDepositor,
      method: "bridgeWethToOvm",
      args: [toAddress, amount, l2Gas, this.l2chainId],
    };
  }

  async queryL1BridgeInitiationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<Event[]> {
    // We need to be smart about the filtering here because the ETHDepositInitiated event does not
    // index on the `toAddress` which is the `fromAddress` that we pass in here and the address we want
    // to actually filter on. So we make some simplifying assumptions:
    // - For our tracking purposes, the ETHDepositInitiated `fromAddress` will be the
    //   AtomicDepositor if the fromAddress is an EOA.
    const isContract = (await this.l1Bridge.provider.getCode(fromAddress)) !== "0x";
    const events = await paginatedEventQuery(
      this.l1Bridge,
      this.l1Bridge.filters.ETHDepositInitiated(isContract ? fromAddress : this.atomicDepositor.address),
      eventConfig
    );
    // If EOA sent the ETH via the AtomicDepositor, then remove any events where the
    // toAddress is not the EOA so we don't get confused with other users using the AtomicDepositor
    if (!isContract) {
      return events.filter((event) => event.args._to === fromAddress);
    }
    return events;
  }

  async queryL2BridgeFinalizationEvents(
    l1Token: string,
    fromAddress: string,
    eventConfig: EventSearchConfig
  ): Promise<Event[]> {
    const isContract = (await this.l2Bridge.provider.getCode(fromAddress)) !== "0x";
    if (!isContract) {
      // When bridging WETH to OP stack chains from an EOA, ETH is bridged via the AtomicDepositor contract
      // and received as ETH on L2. The InventoryClient is built to abstract this subtlety and
      // assumes that WETH is being rebalanced from L1 to L2. Therefore, L1 to L2 ETH transfers sent from an EOA
      // should only be considered finalized if they are followed by an L2 Wrapped Ether "Deposit" event,
      // signifying that the relayer has received WETH into their inventory.
      const l2EthDepositEvents = (
        await paginatedEventQuery(
          this.l2Bridge,
          this.l2Bridge.filters.DepositFinalized(ZERO_ADDRESS, undefined, this.atomicDepositor.address),
          eventConfig
        )
      )
        // If EOA sent the ETH via the AtomicDepositor, then remove any events where the
        // toAddress is not the EOA so we don't get confused with other users using the AtomicDepositor
        .filter((event) => event.args._to === fromAddress);

      // We only care about WETH finalization events initiated by the relayer running this rebalancer logic, so only
      // filter on Deposit events sent from the provided signer. We can't simply filter on `fromAddress` because
      // this would require that the AtomicWethDepositor address wrapped the ETH into WETH, which is not the case for
      // ETH transfers initiated by the AtomicWethDepositor. ETH is sent from the AtomicWethDepositor contract
      // on L1 and received as ETH on L2 by the recipient, which is finally wrapped into WETH on the L2 by the
      // recipient--the L2 signer in this class.
      const l2EthWrapEvents = await this.queryL2WrapEthEvents(fromAddress, eventConfig);

      return matchL2EthDepositAndWrapEvents(l2EthDepositEvents, l2EthWrapEvents);
    } else {
      // Since we can only index on the `fromAddress` for the DepositFinalized event, we can't support
      // monitoring the spoke pool address
      const hubPoolContract = CONTRACT_ADDRESSES[this.hubChainId]?.hubPool?.address;
      if (fromAddress !== hubPoolContract) {
        return [];
      }

      return await paginatedEventQuery(
        this.l2Bridge,
        this.l2Bridge.filters.DepositFinalized(ZERO_ADDRESS, undefined, fromAddress),
        eventConfig
      );
    }
  }

  private queryL2WrapEthEvents(fromAddress: string, eventConfig: EventSearchConfig): Promise<Event[]> {
    return paginatedEventQuery(this.l2Weth, this.l2Weth.filters.Deposit(fromAddress), eventConfig);
  }
}
