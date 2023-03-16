import {
  AugmentedTransaction,
  MultiCallerClient, // tested
  knownRevertReasons,
  unknownRevertReason,
  unknownRevertReasonMethodsToIgnore,
} from "../src/clients";
import { TransactionSimulationResult } from "../src/utils";
import { MockedTransactionClient, txnClientPassResult } from "./mocks/MockTransactionClient";
import { CHAIN_ID_TEST_LIST as chainIds } from "./constants";
import { createSpyLogger, Contract, expect, randomAddress, winston, toBN, ethers, smock } from "./utils";
import { getAbi } from "@uma/contracts-node";

class MockedMultiCallerClient extends MultiCallerClient {
  public ignoredSimulationFailures: TransactionSimulationResult[] = [];
  public loggedSimulationFailures: TransactionSimulationResult[] = [];

  constructor(logger: winston.Logger, chunkSize: { [chainId: number]: number } = {}, public multisend?: Contract) {
    super(logger, chunkSize);
    this.txnClient = new MockedTransactionClient(logger);
  }

  simulationFailureCount(): number {
    return this.loggedSimulationFailures.length + this.ignoredSimulationFailures.length;
  }

  clearSimulationFailures(): void {
    this.ignoredSimulationFailures = [];
    this.loggedSimulationFailures = [];
  }

  private txnCount(txnQueue: { [chainId: number]: AugmentedTransaction[] }): number {
    return Object.values(txnQueue).reduce((count, txnQueue) => (count += txnQueue.length), 0);
  }

  _getMultisender(_: any): Contract | undefined {
    return this.multisend;
  }

  valueTxnCount(): number {
    return this.txnCount(this.valueTxns);
  }

  multiCallTransactionCount(): number {
    return this.txnCount(this.txns);
  }

  protected override logSimulationFailures(txns: TransactionSimulationResult[]): void {
    this.clearSimulationFailures();
    txns.forEach((txn) => {
      (this.canIgnoreRevertReason(txn) ? this.ignoredSimulationFailures : this.loggedSimulationFailures).push(txn);
    });
  }
}

// encodeFunctionData is called from within MultiCallerClient.buildMultiCallBundle.
function encodeFunctionData(_method: string, args: ReadonlyArray<any> = []): string {
  return args.join(" ");
}

const { spyLogger }: { spyLogger: winston.Logger } = createSpyLogger();
const multiCaller: MockedMultiCallerClient = new MockedMultiCallerClient(spyLogger);
const address = randomAddress(); // Test contract address

describe("MultiCallerClient", async function () {
  beforeEach(async function () {
    multiCaller.clearTransactionQueue();
    expect(multiCaller.transactionCount()).to.equal(0);

    multiCaller.clearSimulationFailures();
    expect(multiCaller.simulationFailureCount()).to.equal(0);
  });

  it("Correctly enqueues value transactions", async function () {
    chainIds.forEach((chainId) => multiCaller.enqueueTransaction({ chainId, value: toBN(1) } as AugmentedTransaction));
    expect(multiCaller.valueTxnCount()).to.equal(chainIds.length);
    expect(multiCaller.transactionCount()).to.equal(chainIds.length);
  });

  it("Correctly enqueues non-value transactions", async function () {
    [undefined, toBN(0)].forEach((value) => {
      multiCaller.clearTransactionQueue();
      expect(multiCaller.transactionCount()).to.equal(0);

      chainIds.forEach((chainId) => multiCaller.enqueueTransaction({ chainId, value } as AugmentedTransaction));
      expect(multiCaller.multiCallTransactionCount()).to.equal(chainIds.length);
      expect(multiCaller.transactionCount()).to.equal(chainIds.length);
    });
  });

  it("Correctly enqueues mixed transactions", async function () {
    chainIds.forEach((chainId) => {
      multiCaller.enqueueTransaction({ chainId } as AugmentedTransaction);
      multiCaller.enqueueTransaction({ chainId, value: toBN(1) } as AugmentedTransaction);
    });
    expect(multiCaller.valueTxnCount()).to.equal(chainIds.length);
    expect(multiCaller.multiCallTransactionCount()).to.equal(chainIds.length);
    expect(multiCaller.transactionCount()).to.equal(2 * chainIds.length);
  });

  it("Correctly excludes simulation failures", async function () {
    for (const result of ["Forced simulation failure", txnClientPassResult]) {
      const fail = !(result === txnClientPassResult);
      const txns: AugmentedTransaction[] = chainIds.map((_chainId) => {
        const chainId = Number(_chainId);
        return {
          chainId,
          contract: { address },
          args: [{ result }],
          message: `Test transaction on chain ${chainId}`,
          mrkdwn: `This transaction is expected to ${fail ? "fail" : "pass"} simulation.`,
        } as AugmentedTransaction;
      });

      expect(txns.length).to.equal(chainIds.length);
      const results: AugmentedTransaction[] = await multiCaller.simulateTransactionQueue(txns);
      expect(results.length).to.equal(fail ? 0 : txns.length);

      // Verify that the failed simulations were filtered out.
      expect(multiCaller.simulationFailureCount()).to.equal(fail ? txns.length : 0);
      multiCaller.clearSimulationFailures();
    }
  });

  it("Handles submission success & failure", async function () {
    const nTxns = 4;
    for (const result of ["Forced submission failure", txnClientPassResult]) {
      const fail = !(result === txnClientPassResult);

      for (const value of [0, 1]) {
        const txnType = value > 0 ? "value" : "multicall";

        for (let txn = 1; txn <= nTxns; ++txn) {
          chainIds.forEach((_chainId) => {
            const chainId = Number(_chainId);
            const txnRequest: AugmentedTransaction = {
              chainId,
              contract: {
                address,
                interface: { encodeFunctionData },
              } as Contract,
              method: "test",
              args: [{ result }],
              value: toBN(value),
              message: `Test ${txnType} transaction (${txn}/${nTxns}) on chain ${chainId}`,
              mrkdwn: `Sample markdown string for chain ${chainId} ${txnType} transaction`,
            };

            multiCaller.enqueueTransaction(txnRequest);
          });
        }
      }

      expect(multiCaller.transactionCount()).to.equal(nTxns * 2 * chainIds.length);

      // Note: Half of the txns should be consolidated into a single multicall txn.
      const results: string[] = await multiCaller.executeTransactionQueue();
      expect(results.length).to.equal(fail ? 0 : (nTxns + 1) * chainIds.length);
    }
  });

  it("Correctly filters loggable vs. ignorable simulation failures", async function () {
    const txn = {
      chainId: chainIds[0],
      contract: { address },
    } as AugmentedTransaction;

    // Verify that all known revert reasons are ignored.
    for (const revertReason of knownRevertReasons) {
      txn.args = [{ result: revertReason }];
      txn.message = `Transaction simulation failure; expected to fail with: ${revertReason}.`;

      const result = await multiCaller.simulateTransactionQueue([txn]);
      expect(result.length).to.equal(0);
      expect(multiCaller.ignoredSimulationFailures.length).to.equal(1);
      expect(multiCaller.loggedSimulationFailures.length).to.equal(0);
    }

    // Verify that the defined "unknown" revert reason against known methods is ignored.
    txn.args = [{ result: unknownRevertReason }];
    for (const method of unknownRevertReasonMethodsToIgnore) {
      txn.method = method;
      txn.message = `${txn.method} simulation; expected to fail with: ${unknownRevertReason}.`;

      const result = await multiCaller.simulateTransactionQueue([txn]);
      expect(result.length).to.equal(0);
      expect(multiCaller.ignoredSimulationFailures.length).to.equal(1);
      expect(multiCaller.loggedSimulationFailures.length).to.equal(0);
    }

    // Verify that unexpected revert reason against both known and "unknown" methods are logged.
    for (const method of [...unknownRevertReasonMethodsToIgnore, "randomMethod"]) {
      txn.method = method;

      for (const revertReason of ["unexpected revert reasons", "should not be ignored!"]) {
        txn.args = [{ result: revertReason }];
        txn.message = `${txn.method} simulation; expected to fail with: ${unknownRevertReason}.`;

        const result = await multiCaller.simulateTransactionQueue([txn]);
        expect(result.length).to.equal(0);
        expect(multiCaller.ignoredSimulationFailures.length).to.equal(0);
        expect(multiCaller.loggedSimulationFailures.length).to.equal(1);
      }
    }
  });

  it("Validates transaction data before multicall bundle generation", async function () {
    const chainId = chainIds[0];

    for (const badField of ["address", "chainId"]) {
      const txns: AugmentedTransaction[] = [];

      for (const _idx of [1, 2, 3, 4, 5]) {
        const txn: AugmentedTransaction = {
          chainId,
          contract: {
            address,
            interface: { encodeFunctionData },
          } as Contract,
          method: "test",
          args: ["2"],
          value: toBN(0),
          message: `Test multicall candidate on chain ${chainId}`,
          mrkdwn: "",
        };
        txns.push(txn);
      }

      expect(txns.length).to.not.equal(0);
      expect(() => multiCaller.buildMultiCallBundle(txns)).to.not.throw();

      const badTxn = txns.pop() as AugmentedTransaction;
      switch (badField) {
        case "address":
          badTxn.contract = {
            address: randomAddress(),
            interface: { encodeFunctionData },
          } as Contract;
          break;

        case "chainId":
          badTxn.chainId += 1;
          break;
      }

      txns.push(badTxn);
      expect(() => multiCaller.buildMultiCallBundle(txns)).to.throw("Multicall bundle data mismatch");
    }
  });

  it("Respects multicall bundle chunk size configurations", async function () {
    const chunkSize: { [chainId: number]: number } = Object.fromEntries(
      chainIds.map((_chainId, idx) => {
        const chainId = Number(_chainId);
        return [chainId, 2 + idx * 2];
      })
    );
    const _multiCaller = new MockedMultiCallerClient(spyLogger, chunkSize);

    const testMethod = "test";
    const nFullBundles = 3;
    for (const chainId of chainIds) {
      const multicallTxns: AugmentedTransaction[] = [];
      const _chunkSize = chunkSize[chainId];

      const sampleTxn: AugmentedTransaction = {
        chainId,
        contract: {
          address,
          interface: { encodeFunctionData },
        } as Contract,
        method: testMethod,
        args: [],
        message: "",
        mrkdwn: "",
      };

      const nTxns = nFullBundles * _chunkSize + 1;
      for (let txn = 0; txn < nTxns; ++txn) {
        expect(sampleTxn.method).to.not.equal("multicall");
        multicallTxns.push(sampleTxn);
      }

      const txnQueue: AugmentedTransaction[] = await _multiCaller.buildMultiCallBundles(multicallTxns, _chunkSize);
      expect(txnQueue.length).to.equal(nFullBundles + 1);

      txnQueue.slice(0, nFullBundles).forEach((txn) => {
        // If chunkSize is 1, no multiCall txns will be bundled.
        expect(txn.method).to.equal(_chunkSize > 1 ? "multicall" : testMethod);
      });
      // txnQueue deliberately has one "spare" txn appended, so it should never be bundled.
      txnQueue.slice(-1).forEach((txn) => expect(txn.method).to.equal(testMethod));
    }
  });

  it("Correctly handles 0-length input to multicall bundle generation", async function () {
    const txnQueue: AugmentedTransaction[] = await multiCaller.buildMultiCallBundles([], 10);
    expect(txnQueue.length).to.equal(0);
  });

  it("Correctly handles unpermissioned transactions", async function () {
    const fakeMultisender = await smock.fake(getAbi("Multicall2"), { address: randomAddress() });
    const multicallerWithMultisend = new MockedMultiCallerClient(spyLogger, {}, fakeMultisender as unknown as Contract);

    // Can't pass any transactions to multisender bundler that are permissioned or different chains:
    expect(() =>
      multicallerWithMultisend.buildMultiSenderBundle([
        {
          chainId: 1,
          unpermissioned: false,
          contract: {
            address,
            interface: { encodeFunctionData },
          } as Contract,
          method: "test",
          args: [],
        },
      ] as AugmentedTransaction[])
    ).to.throw("Multisender bundle data mismatch");
    expect(() =>
      multicallerWithMultisend.buildMultiSenderBundle([
        {
          chainId: 1,
          unpermissioned: true,
          contract: {
            address,
            interface: { encodeFunctionData },
          } as Contract,
          method: "test",
          args: [],
        },
        {
          chainId: 2,
          unpermissioned: true,
          contract: {
            address,
            interface: { encodeFunctionData },
          } as Contract,
          method: "test",
          args: [],
        },
      ] as AugmentedTransaction[])
    ).to.throw("Multisender bundle data mismatch");

    // Test returned result of `buildMultiSenderBundle`. Need to check target, expected method, data, etc.
    const unpermissionedTransactions: AugmentedTransaction[] = [
      {
        chainId: 1,
        unpermissioned: true,
        contract: {
          address,
          interface: { encodeFunctionData },
        } as Contract,
        method: "test",
        args: [],
      } as AugmentedTransaction,
    ];
    let multisendTransaction = multicallerWithMultisend.buildMultiSenderBundle(unpermissionedTransactions);
    expect(multisendTransaction.method).to.equal("aggregate");
    expect(multisendTransaction.contract.address).to.equal(fakeMultisender.address);
    expect(multisendTransaction.args[0].length).to.equal(1);
    expect(multisendTransaction.args[0][0].target).to.equal(address);
    expect(multisendTransaction.args[0][0].callData).to.equal(encodeFunctionData("test()", []));

    const secondAddress = randomAddress();
    unpermissionedTransactions.push({
      chainId: 1,
      unpermissioned: true,
      contract: {
        address: secondAddress,
        interface: { encodeFunctionData },
      } as Contract,
      method: "test2",
      args: [11],
    } as AugmentedTransaction);
    multisendTransaction = multicallerWithMultisend.buildMultiSenderBundle(unpermissionedTransactions);
    expect(multisendTransaction.method).to.equal("aggregate");
    expect(multisendTransaction.contract.address).to.equal(fakeMultisender.address);
    expect(multisendTransaction.args[0].length).to.equal(2);
    expect(multisendTransaction.args[0][1].target).to.equal(secondAddress);
    expect(multisendTransaction.args[0][1].callData).to.equal(encodeFunctionData("test2(uint256)", [11]));

    // Test that `buildMultiCallBundles` returns correct list (and order) of transactions
    // given a list of transactions that can be bundled together.
    const permissionedTransaction = [
      {
        chainId: 1,
        contract: {
          address: address,
          interface: { encodeFunctionData },
        } as Contract,
        method: "test",
        args: [],
      },
      {
        chainId: 1,
        contract: {
          address: address,
          interface: { encodeFunctionData },
        } as Contract,
        method: "test",
        args: [],
      },
    ] as AugmentedTransaction[];
    const bundle = multicallerWithMultisend.buildMultiCallBundles([
      ...permissionedTransaction,
      ...unpermissionedTransactions,
    ]);
    expect(bundle.length).to.equal(2);

    expect(bundle[0].method).to.equal("multicall");
    expect(bundle[1].method).to.equal("aggregate");
    expect(bundle[1].args[0][0].target).to.equal(address);
    expect(bundle[1].args[0][1].target).to.equal(secondAddress);
    expect(bundle[1].args[0][0].callData).to.equal(encodeFunctionData("test()", []));
    expect(bundle[1].args[0][1].callData).to.equal(encodeFunctionData("test2(uint256)", [11]));
  });
});
