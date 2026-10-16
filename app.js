const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
});

const transactions = document.querySelector("#transactions");
const transferForm = document.querySelector("#transfer-form");
const formMessage = document.querySelector("#form-message");
const receiptDialog = document.querySelector("#receipt-dialog");
const submitButton = transferForm.querySelector('button[type="submit"]');
const submitLabel = submitButton.querySelector(".button-label");
const toast = document.querySelector("#toast");
const siteHeader = document.querySelector(".site-header");
const menuToggle = document.querySelector(".menu-toggle");
const balanceCard = document.querySelector(".balance-card");
const balanceVisibility = document.querySelector("#balance-visibility");
const cardDetailTitle = document.querySelector("#card-detail-title");
const cardDetailCopy = document.querySelector("#card-detail-copy");
const cardDetailPrice = document.querySelector("#card-detail-price");
const creditForm = document.querySelector("#credit-form");
const creditAmount = document.querySelector("#credit-amount");
const creditRange = document.querySelector("#credit-range");
const creditTerm = document.querySelector("#credit-term");
const creditError = document.querySelector("#credit-error");
const monthlyPayment = document.querySelector("#monthly-payment");
const interestTotal = document.querySelector("#interest-total");
const repaymentTotal = document.querySelector("#repayment-total");
let accountBalanceKopecks = null;
let toastTimeout;
let creditCalculationTimeout;
let creditRequestId = 0;
let dashboardTransactions = [];
let accountSuffix = null;

const cardDetails = {
  cash: {
    title: "FYG Cash",
    copy: "Зелёный концепт карты для повседневных расходов. В этом прототипе карта только нарисована — оплатить ею нельзя.",
    price: "Условие в макете: без платы",
  },
  platinum: {
    title: "FYG Platinum",
    copy: "Светлый концепт с холодным металлическим блеском. Тариф на карточке — часть вымышленного макета, услуга не существует.",
    price: "Условие в макете: $990 в год",
  },
  credit: {
    title: "FYG Credit",
    copy: "Тёмно-синий концепт. Калькулятор ниже показывает пример расчёта, но не оформляет заявку и не выдаёт кредит.",
    price: "Условие в макете: 24% годовых",
  },
};

function formatMoney(kopecks) {
  return money.format(kopecks / 100);
}

function formatDate(value) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function openReceipt(transaction) {
  const recipient = transaction.recipient ||
    /^Перевод · (.+)$/.exec(transaction.description)?.[1];
  if (transaction.type !== "expense" || !recipient) return;
  document.querySelector("#receipt-amount").textContent = formatMoney(Math.abs(transaction.amountKopecks));
  document.querySelector("#receipt-sender").textContent = "Владелец демо-счёта";
  document.querySelector("#receipt-sender-account").textContent = `FYG.Bank ···· ${accountSuffix ?? "—"}`;
  document.querySelector("#receipt-recipient").textContent = recipient;
  document.querySelector("#receipt-recipient-account").textContent =
    /^\d{4}$/.test(transaction.recipientAccountSuffix ?? "")
      ? `Счёт ···· ${transaction.recipientAccountSuffix}`
      : "Демо-реквизиты не сохранены";
  document.querySelector("#receipt-date").textContent = formatDate(transaction.createdAt);
  document.querySelector("#receipt-operation-id").textContent = transaction.id.slice(0, 8).toUpperCase();
  if (!receiptDialog.open) receiptDialog.showModal();
}

async function parseApiResponse(response) {
  const text = await response.text();
  if (!text.trim()) {
    throw new Error(`Сервер вернул пустой ответ (HTTP ${response.status}).`);
  }

  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(`Сервер вернул некорректный JSON (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    throw new Error(typeof result.error === "string"
      ? result.error
      : `Ошибка запроса (HTTP ${response.status}).`);
  }
  return result;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimeout);
  toastTimeout = window.setTimeout(() => toast.classList.remove("visible"), 4200);
}

function renderBalance() {
  if (accountBalanceKopecks === null) return;
  const formattedBalance = balanceCard.classList.contains("is-hidden")
    ? "••••••••"
    : formatMoney(accountBalanceKopecks);
  document.querySelector("#balance").textContent = formattedBalance;
  document.querySelector("#available-balance").textContent = formattedBalance;
}

function setMenuOpen(isOpen) {
  siteHeader.classList.toggle("menu-open", isOpen);
  menuToggle.setAttribute("aria-expanded", String(isOpen));
  menuToggle.setAttribute("aria-label", isOpen ? "Закрыть меню" : "Открыть меню");
}

menuToggle.addEventListener("click", () => {
  setMenuOpen(menuToggle.getAttribute("aria-expanded") !== "true");
});

siteHeader.querySelectorAll(".main-nav a").forEach((link) => {
  link.addEventListener("click", () => setMenuOpen(false));
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menuToggle.getAttribute("aria-expanded") === "true") {
    setMenuOpen(false);
    menuToggle.focus();
  }
});

document.addEventListener("click", (event) => {
  if (!siteHeader.contains(event.target)) setMenuOpen(false);
});

balanceVisibility.addEventListener("click", () => {
  const isHidden = balanceCard.classList.toggle("is-hidden");
  renderBalance();
  balanceVisibility.setAttribute("aria-pressed", String(isHidden));
  const label = isHidden ? "Показать суммы" : "Скрыть суммы";
  balanceVisibility.setAttribute("aria-label", isHidden ? "Показать баланс" : "Скрыть баланс");
  balanceVisibility.title = label;
  balanceVisibility.querySelector(".visibility-label").textContent = label;
});

document.querySelectorAll(".product-option").forEach((option) => {
  option.addEventListener("click", () => {
    const details = cardDetails[option.dataset.card];
    if (!details) return;

    document.querySelectorAll(".product-option").forEach((item) => {
      item.setAttribute("aria-pressed", String(item === option));
    });
    cardDetailTitle.textContent = details.title;
    cardDetailCopy.textContent = details.copy;
    cardDetailPrice.textContent = details.price;
    if (option.dataset.card === "credit") {
      document.querySelector("#credit").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
});

function renderCreditQuote(quote) {
  monthlyPayment.textContent = formatMoney(quote.monthlyPaymentKopecks);
  document.querySelector("#result-rate").textContent = `${quote.annualRatePercent}% годовых`;
  interestTotal.textContent = formatMoney(quote.interestKopecks);
  repaymentTotal.textContent = formatMoney(quote.totalPaymentKopecks);
}

async function calculateCredit(showValidation = false) {
  const amount = Number(creditAmount.value);
  const termMonths = Number(creditTerm.value);
  if (!creditForm.checkValidity()) {
    if (showValidation) creditForm.reportValidity();
    creditRequestId += 1;
    monthlyPayment.textContent = "Укажите сумму";
    interestTotal.textContent = "—";
    repaymentTotal.textContent = "—";
    return;
  }

  const requestId = ++creditRequestId;
  creditError.textContent = "";
  monthlyPayment.textContent = "Считаем…";
  try {
    const response = await fetch("/api/credit/calculate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount, termMonths }),
    });
    const result = await parseApiResponse(response);
    if (requestId !== creditRequestId) return;
    renderCreditQuote(result);
  } catch (error) {
    if (requestId !== creditRequestId) return;
    monthlyPayment.textContent = "Расчёт недоступен";
    interestTotal.textContent = "—";
    repaymentTotal.textContent = "—";
    creditError.textContent = error instanceof Error ? error.message : "Не удалось выполнить расчёт. Попробуйте ещё раз.";
  }
}

function scheduleCreditCalculation() {
  window.clearTimeout(creditCalculationTimeout);
  creditCalculationTimeout = window.setTimeout(() => void calculateCredit(), 220);
}

creditForm.addEventListener("submit", (event) => {
  event.preventDefault();
  window.clearTimeout(creditCalculationTimeout);
  void calculateCredit(true);
});

creditAmount.addEventListener("input", () => {
  const amount = Number(creditAmount.value);
  if (creditAmount.value !== "" && amount >= Number(creditRange.min) && amount <= Number(creditRange.max)) {
    creditRange.value = String(amount);
  }
  scheduleCreditCalculation();
});

creditRange.addEventListener("input", () => {
  creditAmount.value = creditRange.value;
  scheduleCreditCalculation();
});

creditTerm.addEventListener("change", scheduleCreditCalculation);

function renderTransactions(items) {
  if (items.length === 0) {
    transactions.innerHTML = '<li class="empty-state">Пока нет операций по счёту.</li>';
    return;
  }

  transactions.innerHTML = items
    .map((item) => {
      const incoming = item.type === "income";
      const amount = formatMoney(Math.abs(item.amountKopecks));
      const signedAmount = incoming ? `+ ${amount}` : `− ${amount}`;
      const label = incoming ? "Поступление" : "Перевод";
      const icon = incoming ? "↙" : "↗";
      const transaction = `<div class="transaction-info">
          <span class="transaction-icon" aria-hidden="true">${icon}</span>
          <div><div class="transaction-name">${escapeHtml(item.description)}</div>
          <div class="transaction-date">${formatDate(item.createdAt)} · ${label}</div></div>
        </div>
        <span class="transaction-amount${incoming ? " income" : ""}">${signedAmount}</span>`;
      const receiptRecipient = item.recipient ||
        /^Перевод · (.+)$/.exec(item.description)?.[1];
      if (!incoming && receiptRecipient) {
        return `<li class="transaction-item"><button class="transaction transaction-button" type="button" data-receipt-id="${escapeHtml(item.id)}" aria-label="Открыть чек: перевод ${escapeHtml(formatMoney(Math.abs(item.amountKopecks)))} получателю ${escapeHtml(receiptRecipient)}">${transaction}</button></li>`;
      }
      return `<li class="transaction">
        ${transaction}
      </li>`;
    })
    .join("");
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

async function loadDashboard() {
  const response = await fetch("/api/dashboard");
  const dashboard = await parseApiResponse(response);
  accountBalanceKopecks = dashboard.balanceKopecks;
  accountSuffix = dashboard.accountSuffix;
  renderBalance();
  document.querySelector("#account-number").textContent = `Демо-счёт ···· ${dashboard.accountSuffix}`;
  dashboardTransactions = dashboard.transactions;
  renderTransactions(dashboardTransactions);
}

transferForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!transferForm.reportValidity()) return;

  formMessage.textContent = "";
  formMessage.className = "form-message";
  submitButton.disabled = true;
  submitLabel.textContent = "Проверяем перевод…";

  try {
    const formData = new FormData(transferForm);
    const response = await fetch("/api/transfers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: formData.get("recipient"),
        account: formData.get("account"),
        amount: Number(formData.get("amount")),
      }),
    });
    const result = await parseApiResponse(response);

    transferForm.reset();
    accountBalanceKopecks = result.balanceKopecks;
    renderBalance();
    dashboardTransactions = [result.transfer, ...dashboardTransactions].slice(0, 8);
    renderTransactions(dashboardTransactions);
    openReceipt(result.transfer);
    const balanceSummary = balanceCard.classList.contains("is-hidden")
      ? ""
      : ` Новый баланс: ${formatMoney(result.balanceKopecks)}.`;
    formMessage.textContent = `В демо переведено ${formatMoney(Math.abs(result.transfer.amountKopecks))}.${balanceSummary}`;
    formMessage.classList.add("success");
    showToast("Тестовый перевод добавлен в историю демо-счёта.");
  } catch (error) {
    formMessage.textContent = error instanceof Error ? error.message : "Произошла ошибка. Попробуйте ещё раз.";
    formMessage.classList.add("error");
  } finally {
    submitButton.disabled = false;
    submitLabel.textContent = "Провести демо-перевод";
  }
});

transactions.addEventListener("click", (event) => {
  const button = event.target.closest("[data-receipt-id]");
  if (!button) return;
  const transaction = dashboardTransactions.find((item) => item.id === button.dataset.receiptId);
  if (transaction) openReceipt(transaction);
});

receiptDialog.addEventListener("click", (event) => {
  if (event.target.matches("[data-receipt-close]")) receiptDialog.close();
  if (event.target === receiptDialog) receiptDialog.close();
});

document.querySelector("#receipt-print").addEventListener("click", () => window.print());

loadDashboard().catch((error) => {
  document.querySelector("#balance").textContent = "Нет данных";
  document.querySelector("#available-balance").textContent = "—";
  document.querySelector("#transactions").innerHTML = '<li class="empty-state">Не удалось загрузить историю. Попробуйте обновить страницу.</li>';
  showToast(error.message);
});

void calculateCredit();
