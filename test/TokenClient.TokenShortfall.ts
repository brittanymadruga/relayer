import { deploySpokePoolWithToken, expect, ethers, Contract, SignerWithAddress } from "./utils";
import { createSpyLogger, winston, originChainId, destinationChainId, toBN, toBNWei } from "./utils";
import { TokenClient, SpokePoolClient } from "../src/clients";

let spokePool_1: Contract, spokePool_2: Contract;
let erc20_1: Contract, weth_1: Contract, erc20_2: Contract, weth_2: Contract;
let spokePoolClient_1: SpokePoolClient, spokePoolClient_2: SpokePoolClient;
let owner: SignerWithAddress, spy: sinon.SinonSpy, spyLogger: winston.Logger;
let tokenClient: TokenClient; // tested

describe("TokenClient: Token shortfall", async function () {
  beforeEach(async function () {
    [owner] = await ethers.getSigners();
    ({ spy, spyLogger } = createSpyLogger());
    // Using deploySpokePoolWithToken will create two tokens and enable both of them as routes.
    ({ spokePool: spokePool_1, erc20: erc20_1 } = await deploySpokePoolWithToken(originChainId, destinationChainId));
    ({ spokePool: spokePool_2, erc20: erc20_2 } = await deploySpokePoolWithToken(destinationChainId, originChainId));

    spokePoolClient_1 = new SpokePoolClient(createSpyLogger().spyLogger, spokePool_1, null, originChainId);
    spokePoolClient_2 = new SpokePoolClient(createSpyLogger().spyLogger, spokePool_2, null, destinationChainId);

    const spokePoolClients = { [destinationChainId]: spokePoolClient_1, [originChainId]: spokePoolClient_2 };

    tokenClient = new TokenClient(spyLogger, owner.address, spokePoolClients);
  });

  it("Captures and tracks token shortfall", async function () {
    await updateAllClients();
    expect(tokenClient.getTokenShortfall()).to.deep.equal({});

    // Mint token balance to 69. Try and fill a deposit of 420. There should be a token shortfall of 420-69 = 351.
    await erc20_2.mint(owner.address, toBNWei("69"));
    await updateAllClients();
    const depositId = 1;

    tokenClient.captureTokenShortfall(destinationChainId, erc20_2.address, depositId, toBNWei(420));
    expect(tokenClient.getTokenShortfall()).to.deep.equal({
      [destinationChainId]: { [erc20_2.address]: { deposits: [depositId], shortfall: toBNWei(351) } },
    });

    // A subsequent shortfall deposit of 42 should add to the token shortfall and append the deposit id as 351+42 = 393.
    const depositId2 = 2;

    tokenClient.captureTokenShortfall(destinationChainId, erc20_2.address, depositId2, toBNWei(42));
    expect(tokenClient.getTokenShortfall()).to.deep.equal({
      [destinationChainId]: { [erc20_2.address]: { deposits: [depositId, depositId2], shortfall: toBNWei(393) } },
    });

    // Updating the client should not impact anything.
    await updateAllClients();
    expect(tokenClient.getTokenShortfall()).to.deep.equal({
      [destinationChainId]: { [erc20_2.address]: { deposits: [depositId, depositId2], shortfall: toBNWei(393) } },
    });
  });
});

async function updateAllClients() {
  await spokePoolClient_1.update();
  await spokePoolClient_2.update();
  await tokenClient.update();
}
