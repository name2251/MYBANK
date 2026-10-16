const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createBankServer } = require("../server");

async function withBank(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fyg-bank-test-"));
  const dataFile = path.join(directory, "bank.json");
  let server;
  try {
    server = await createBankServer({ dataFile });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    await run({ baseUrl, dataFile });
  } finally {
    if (server?.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function sendTransfer(baseUrl, transfer) {
  return fetch(`${baseUrl}/api/transfers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(transfer),
  });
}

test("serves the bank page and dashboard", async () => {
  await withBank(async ({ baseUrl }) => {
    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
    const html = await page.text();
    assert.match(html, /FYG\.Bank/);
    assert.match(html, /ПРОТОТИП \/ FYG/);
    assert.match(html, /ДЕМО-СЧЁТ/);
    assert.match(html, /Не вводите реальные персональные или платёжные данные/);
    assert.match(html, /Для реального запуска нужны согласованное ТЗ и настройка организаторами/);
    assert.match(html, /Провести демо-перевод/);
    assert.match(html, /id="receipt-dialog"/);
    assert.match(html, /НЕ ПЛАТЁЖНЫЙ ДОКУМЕНТ/);
    assert.match(html, /ДЕМО · НЕ ДЛЯ ОПЛАТЫ/);
    assert.match(html, /1234\s+5678\s+9012\s+3456/);
    assert.match(html, /03\/33/);
    assert.match(html, /вымышленные примеры для дизайна/);
    assert.doesNotMatch(html, /mastercard-mark|АЛЕКСАНДР ИВАНОВ/);
    assert.match(html, /class="menu-toggle"[^>]*aria-expanded="false"/);
    assert.match(html, /id="balance-visibility"/);
    assert.match(html, /id="cards"/);
    assert.match(html, /id="credit"/);

    const app = await fetch(`${baseUrl}/app.js`);
    assert.equal(app.status, 200);
    const appSource = await app.text();
    assert.match(appSource, /balanceVisibility\.addEventListener/);
    assert.match(appSource, /product-option/);
    assert.match(appSource, /\/api\/credit\/calculate/);
    assert.match(appSource, /Перевод · \(\.\+\)/);

    const styles = await fetch(`${baseUrl}/style.css`);
    assert.equal(styles.status, 200);
    const css = await styles.text();
    assert.match(css, /animation: card-intro 4\.8s cubic-bezier/);
    assert.match(css, /@keyframes card-intro/);
    assert.match(css, /max-width: 780px/);
    assert.match(css, /font-family: var\(--display-font\)/);
    assert.match(css, /rotateY\(360deg\)/);
    assert.match(css, /transform-style: preserve-3d/);
    assert.match(css, /backface-visibility: hidden/);
    assert.match(html, /class="hero-card-face hero-card-back" aria-hidden="true"/);
    assert.match(css, /prefers-reduced-motion: reduce/);

    const dashboardResponse = await fetch(`${baseUrl}/api/dashboard`);
    assert.equal(dashboardResponse.status, 200);
    const dashboard = await dashboardResponse.json();
    assert.equal(dashboard.balanceKopecks, 128_450_050);
    assert.equal(dashboard.accountSuffix, "4821");
    assert.equal(dashboard.transactions.length, 3);
  });
});

test("calculates a demo annuity credit quote without changing the account", async () => {
  await withBank(async ({ baseUrl, dataFile }) => {
    const quoteResponse = await fetch(`${baseUrl}/api/credit/calculate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 100_000, termMonths: 12 }),
    });
    assert.equal(quoteResponse.status, 200);
    assert.equal(quoteResponse.headers.get("cache-control"), "no-store");
    const quote = await quoteResponse.json();
    const expectedMonthlyPayment = Math.round(
      10_000_000 * (0.24 / 12) / (1 - (1 + 0.24 / 12) ** -12),
    );
    assert.equal(quote.principalKopecks, 10_000_000);
    assert.equal(quote.annualRatePercent, 24);
    assert.equal(quote.termMonths, 12);
    assert.equal(quote.monthlyPaymentKopecks, expectedMonthlyPayment);
    assert.equal(quote.totalPaymentKopecks, expectedMonthlyPayment * 12);
    assert.equal(quote.interestKopecks, quote.totalPaymentKopecks - quote.principalKopecks);
    assert.equal(quote.isOffer, false);
    assert.equal(await readFile(dataFile).catch((error) => error.code), "ENOENT");

    const dashboard = await (await fetch(`${baseUrl}/api/dashboard`)).json();
    assert.equal(dashboard.balanceKopecks, 128_450_050);
  });
});

test("rejects credit quote amounts and terms outside the advertised limits", async () => {
  await withBank(async ({ baseUrl }) => {
    for (const quote of [
      { amount: 9_999, termMonths: 12 },
      { amount: 2_000_001, termMonths: 12 },
      { amount: 50_000, termMonths: 2 },
      { amount: 50_000, termMonths: 61 },
      { amount: 50_000, termMonths: 12.5 },
    ]) {
      const response = await fetch(`${baseUrl}/api/credit/calculate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(quote),
      });
      assert.equal(response.status, 400);
      assert.equal(typeof (await response.json()).error, "string");
    }
  });
});

test("validates transfers and leaves the balance unchanged on failure", async () => {
  await withBank(async ({ baseUrl }) => {
    const invalidTransfers = [
      { recipient: "A", account: "123456", amount: 100 },
      { recipient: "Получатель", account: "wrong-account", amount: 100 },
      { recipient: "Получатель", account: "123456", amount: 0 },
      { recipient: "Получатель", account: "123456", amount: 500_001 },
      { recipient: "Получатель", account: "123456", amount: 128_450_051 },
    ];

    for (const transfer of invalidTransfers) {
      const response = await sendTransfer(baseUrl, transfer);
      assert.equal(response.status, 400);
      assert.equal(typeof (await response.json()).error, "string");
    }

    const dashboard = await (await fetch(`${baseUrl}/api/dashboard`)).json();
    assert.equal(dashboard.balanceKopecks, 128_450_050);
    assert.equal(dashboard.transactions.length, 3);
  });
});

test("serializes concurrent transfers to prevent spending the same balance twice", async () => {
  await withBank(async ({ baseUrl }) => {
    const transfer = { recipient: "Получатель", account: "1234567890", amount: 500_000 };
    const responses = await Promise.all([
      sendTransfer(baseUrl, transfer),
      sendTransfer(baseUrl, transfer),
      sendTransfer(baseUrl, transfer),
    ]);

    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 201, 400]);
    const dashboard = await (await fetch(`${baseUrl}/api/dashboard`)).json();
    assert.equal(dashboard.balanceKopecks, 28_450_050);
    assert.equal(dashboard.transactions.length, 5);
  });
});

test("persists successful transfers and reloads them on server restart", async () => {
  await withBank(async ({ baseUrl, dataFile }) => {
    const response = await sendTransfer(baseUrl, {
      recipient: "Мария Петрова",
      account: "40817810012345678901",
      amount: 1250.5,
    });
    assert.equal(response.status, 201);

    const savedState = JSON.parse(await readFile(dataFile, "utf8"));
    assert.equal(savedState.balanceKopecks, 128_325_000);
    assert.equal(savedState.transactions[0].description, "Перевод · Мария Петрова");
    assert.equal(savedState.transactions[0].recipient, "Мария Петрова");
    assert.equal(savedState.transactions[0].recipientAccountSuffix, "8901");
    assert.equal(JSON.stringify(savedState.transactions[0]).includes("40817810012345678901"), false);

    const restarted = await createBankServer({ dataFile });
    await new Promise((resolve, reject) => {
      restarted.once("error", reject);
      restarted.listen(0, "127.0.0.1", resolve);
    });
    try {
      const dashboard = await (await fetch(`http://127.0.0.1:${restarted.address().port}/api/dashboard`)).json();
      assert.equal(dashboard.balanceKopecks, 128_325_000);
      assert.equal(dashboard.transactions[0].description, "Перевод · Мария Петрова");
      assert.equal(dashboard.transactions[0].recipient, "Мария Петрова");
      assert.equal(dashboard.transactions[0].recipientAccountSuffix, "8901");
    } finally {
      await new Promise((resolve, reject) => restarted.close((error) => error ? reject(error) : resolve()));
    }
  });
});
