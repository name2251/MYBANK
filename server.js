const http = require("node:http");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");

const DEFAULT_DATA_FILE = path.join(__dirname, ".data", "fyg-bank.json");
const MAX_BODY_BYTES = 16 * 1024;
const MAX_TRANSFER_KOPECKS = 50_000_000;
const CREDIT_ANNUAL_RATE_PERCENT = 24;
const MIN_CREDIT_KOPECKS = 1_000_000;
const MAX_CREDIT_KOPECKS = 200_000_000;
const MIN_CREDIT_TERM_MONTHS = 3;
const MAX_CREDIT_TERM_MONTHS = 60;
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function createInitialState() {
  const now = Date.now();
  return {
    balanceKopecks: 128_450_050,
    accountSuffix: "4821",
    transactions: [
      { id: randomUUID(), description: "Поступление средств", amountKopecks: 87_500_00, type: "income", createdAt: new Date(now - 1_800_000).toISOString() },
      { id: randomUUID(), description: "Кофейня · Центр", amountKopecks: -680_00, type: "expense", createdAt: new Date(now - 86_400_000).toISOString() },
      { id: randomUUID(), description: "Оплата связи", amountKopecks: -790_00, type: "expense", createdAt: new Date(now - 172_800_000).toISOString() },
    ],
  };
}

async function loadState(dataFile) {
  try {
    const contents = await readFile(dataFile, "utf8");
    const state = JSON.parse(contents);
    const validTransactions = Array.isArray(state.transactions) && state.transactions.every((transaction) =>
      transaction &&
      typeof transaction.id === "string" &&
      typeof transaction.description === "string" &&
      Number.isSafeInteger(transaction.amountKopecks) &&
      ["income", "expense"].includes(transaction.type) &&
      typeof transaction.createdAt === "string" &&
      Number.isFinite(Date.parse(transaction.createdAt)) &&
      (typeof transaction.recipient === "undefined" || typeof transaction.recipient === "string") &&
      (typeof transaction.recipientAccountSuffix === "undefined" || /^\d{4}$/.test(transaction.recipientAccountSuffix)),
    );
    if (
      !Number.isSafeInteger(state.balanceKopecks) ||
      state.balanceKopecks < 0 ||
      !validTransactions ||
      !/^\d{4}$/.test(state.accountSuffix)
    ) {
      throw new Error(`Bank data file has an invalid format: ${dataFile}`);
    }
    return state;
  } catch (error) {
    if (error.code === "ENOENT") return createInitialState();
    throw error;
  }
}

async function persistState(dataFile, state) {
  await mkdir(path.dirname(dataFile), { recursive: true });
  const temporaryFile = `${dataFile}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryFile, dataFile);
}

async function readJson(request) {
  if (!request.headers["content-type"]?.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "Ожидается запрос в формате JSON.");
  }

  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) throw new ApiError(413, "Размер запроса превышает допустимый лимит.");

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "Запрос содержит некорректный JSON.");
  }
}

function normalizeTransfer(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "Проверьте данные перевода.");
  }

  const recipient = typeof body.recipient === "string" ? body.recipient.trim() : "";
  const account = typeof body.account === "string" ? body.account.replaceAll(" ", "") : "";
  const amount = body.amount;
  if (recipient.length < 2 || recipient.length > 60) {
    throw new ApiError(400, "Укажите имя получателя длиной от 2 до 60 символов.");
  }
  if (!/^\d{6,34}$/.test(account)) {
    throw new ApiError(400, "Номер счёта должен содержать от 6 до 23 цифр.");
  }
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new ApiError(400, "Укажите корректную сумму перевода.");
  }

  const amountKopecks = Math.round((amount + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(amountKopecks) || amountKopecks < 1 || amountKopecks > MAX_TRANSFER_KOPECKS) {
    throw new ApiError(400, "Сумма перевода должна быть от 0,70 до 100 000 долларов.");
  }
  return { recipient, account, recipientAccountSuffix: account.slice(-4), amountKopecks };
}

function calculateCreditQuote(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "Проверьте параметры расчёта.");
  }

  const { amount, termMonths } = body;
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new ApiError(400, "Укажите корректную сумму кредита.");
  }

  const principalKopecks = Math.round((amount + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(principalKopecks) || principalKopecks < MIN_CREDIT_KOPECKS || principalKopecks > MAX_CREDIT_KOPECKS) {
    throw new ApiError(400, "Сумма кредита должна быть от 10 000 до 2 000 000 долларов.");
  }
  if (!Number.isInteger(termMonths) || termMonths < MIN_CREDIT_TERM_MONTHS || termMonths > MAX_CREDIT_TERM_MONTHS) {
    throw new ApiError(400, "Срок кредита должен быть от 3 до 60 месяцев.");
  }

  const monthlyRate = CREDIT_ANNUAL_RATE_PERCENT / 100 / 12;
  const annuityFactor = monthlyRate / (1 - (1 + monthlyRate) ** -termMonths);
  const monthlyPaymentKopecks = Math.round(principalKopecks * annuityFactor);
  const totalPaymentKopecks = monthlyPaymentKopecks * termMonths;

  return {
    principalKopecks,
    annualRatePercent: CREDIT_ANNUAL_RATE_PERCENT,
    termMonths,
    monthlyPaymentKopecks,
    totalPaymentKopecks,
    interestKopecks: totalPaymentKopecks - principalKopecks,
    calculation: "annuity-estimate",
    isOffer: false,
  };
}

async function createBankServer({ dataFile = process.env.FYG_DATA_FILE || DEFAULT_DATA_FILE } = {}) {
  let state = await loadState(dataFile);
  let mutationQueue = Promise.resolve();

  function updateState(update) {
    const operation = mutationQueue.then(async () => {
      const nextState = {
        ...state,
        transactions: state.transactions.map((transaction) => ({ ...transaction })),
      };
      const result = update(nextState);
      await persistState(dataFile, nextState);
      state = nextState;
      return result;
    });
    mutationQueue = operation.catch(() => {});
    return operation;
  }

  async function handle(request, response) {
    const url = new URL(request.url, "http://localhost");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");

    if (request.method === "GET" && url.pathname === "/api/healthz") {
      return sendJson(response, 200, { status: "ok" });
    }
    if (request.method === "GET" && url.pathname === "/api/dashboard") {
      response.setHeader("Cache-Control", "no-store");
      return sendJson(response, 200, {
        balanceKopecks: state.balanceKopecks,
        accountSuffix: state.accountSuffix,
        transactions: state.transactions.slice(0, 8),
      });
    }
    if (request.method === "POST" && url.pathname === "/api/credit/calculate") {
      const quote = calculateCreditQuote(await readJson(request));
      return sendJson(response, 200, quote);
    }
    if (request.method === "POST" && url.pathname === "/api/transfers") {
      const transfer = normalizeTransfer(await readJson(request));
      const result = await updateState((nextState) => {
        if (transfer.amountKopecks > nextState.balanceKopecks) {
          throw new ApiError(400, "Недостаточно средств на счёте.");
        }
        const transaction = {
          id: randomUUID(),
          description: `Перевод · ${transfer.recipient}`,
          amountKopecks: -transfer.amountKopecks,
          type: "expense",
          recipient: transfer.recipient,
          recipientAccountSuffix: transfer.recipientAccountSuffix,
          createdAt: new Date().toISOString(),
        };
        nextState.balanceKopecks -= transfer.amountKopecks;
        nextState.transactions.unshift(transaction);
        nextState.transactions = nextState.transactions.slice(0, 200);
        return { transfer: transaction, balanceKopecks: nextState.balanceKopecks };
      });
      response.setHeader("Cache-Control", "no-store");
      return sendJson(response, 201, result);
    }
    if (request.method !== "GET" && url.pathname.startsWith("/api/")) {
      response.setHeader("Allow", "GET, POST");
      throw new ApiError(405, "Этот способ запроса не поддерживается.");
    }
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      throw new ApiError(405, "Этот способ запроса не поддерживается.");
    }

    const file = STATIC_FILES.get(url.pathname);
    if (!file) throw new ApiError(404, "Страница не найдена.");
    const contents = await readFile(path.join(__dirname, file[0]));
    response.writeHead(200, {
      "Content-Type": file[1],
      "Cache-Control": "no-cache",
    });
    response.end(contents);
  }

  return http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      if (error instanceof ApiError) {
        return sendJson(response, error.status, { error: error.message });
      }
      console.error("FYG.Bank request failed:", error);
      sendJson(response, 500, { error: "Не удалось обработать запрос. Попробуйте позже." });
    });
  });
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function start() {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }
  const server = await createBankServer();
  server.listen(port, "0.0.0.0", () => {
    const address = server.address();
    console.log(`FYG.Bank demo is available at http://localhost:${address.port}`);
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error("Could not start FYG.Bank:", error);
    process.exitCode = 1;
  });
}

module.exports = { calculateCreditQuote, createBankServer };
