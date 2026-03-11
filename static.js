// Utility helpers
function formatCurrency(value, decimals = 2) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

function formatDateLabel(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// --- Footer year ---
document.addEventListener("DOMContentLoaded", () => {
  const yearEl = document.getElementById("footer-year");
  if (yearEl) {
    yearEl.textContent = String(new Date().getFullYear());
  }
});

// --- Demo forms ---
document.addEventListener("DOMContentLoaded", () => {
  const evSubmit = document.getElementById("evangelist-form-submit");
  const evMsg = document.getElementById("evangelist-form-message");
  if (evSubmit && evMsg) {
    evSubmit.addEventListener("click", () => {
      evMsg.textContent =
        "Thanks! This is a static demo – hook this form up to your backend, email provider, or form service.";
    });
  }

  const stSubmit = document.getElementById("stacker-form-submit");
  const stMsg = document.getElementById("stacker-form-message");
  if (stSubmit && stMsg) {
    stSubmit.addEventListener("click", () => {
      stMsg.textContent =
        "Your stacking plan looks great! In the full app this would create a real DCA agreement.";
    });
  }
});

// --- Load data and initialize charts only after DOM & Chart.js are ready ---
document.addEventListener("DOMContentLoaded", () => {
  if (typeof Chart === "undefined") {
    // Chart.js not available – silently skip charts
    return;
  }

  // For the BTC vs Bink price chart we keep using the bundled historical JSON,
  // since it's a demo of Bink pricing vs exchanges over a recent window.
  fetch("./data/btcusd-daily-price-last_quarter.json")
    .then((r) => r.json())
    .then((dailyData) => {
      initBinkPriceChart(dailyData);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("Error loading daily price data", err);
    });

  // For the DCA calculator and stacker dashboard we pull live BTC/USD data
  // from a free, no-key provider (Blockchain.com charts API). This runs
  // entirely client-side and requires no secret.
  fetchLiveBtcHistoryFromBlockchain()
    .then((livePriceData) => {
      initDcaCalculator(livePriceData);
      initStackerDashboard(livePriceData);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("Error loading live BTC data, falling back to bundled weekly JSON", err);
      // Fallback to local historical JSON if the public API is rate-limited or unavailable.
      fetch("./data/btcusd-weekly-price-historical.json")
        .then((r) => r.json())
        .then((weeklyData) => {
          initDcaCalculator(weeklyData);
          initStackerDashboard(weeklyData);
        })
        .catch((innerErr) => {
          // eslint-disable-next-line no-console
          console.error("Error loading fallback weekly price data", innerErr);
        });
    });
});

// === DCA core data helpers ===

// Fetch recent BTC/USD daily prices from Blockchain.com's free charts API
// and normalize into [{ date, price }] to match the existing calculator logic.
// Docs: https://www.blockchain.com/api/charts_api
async function fetchLiveBtcHistoryFromBlockchain(days = 365) {
  // Blockchain.com market-price chart supports JSON, daily sampling, and no API key.
  // We request up to `days` of history; the API's "timespan" parameter accepts strings
  // like "365days", "2years", etc. Here we clamp between 1 and 365 days.
  const safeDays = Math.min(Math.max(days, 1), 365);
  const url = `https://api.blockchain.info/charts/market-price?timespan=${safeDays}days&format=json&sampled=true`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Blockchain.com HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!data || !Array.isArray(data.values)) {
    throw new Error("Unexpected Blockchain.com response structure");
  }

  // values: [{ x: timestamp_seconds, y: price }, ...]
  return data.values.map((point) => {
    const d = new Date(point.x * 1000);
    return {
      date: d.toISOString().slice(0, 10),
      price: Number(point.y),
    };
  });
}

// Downsample a dense series of daily-or-more-frequent points into an
// approximate weekly series by taking one point every 7 distinct dates.
function downsampleToApproxWeekly(dailySeries) {
  if (!dailySeries || dailySeries.length === 0) return [];

  const byDate = [];
  let lastDate = null;
  dailySeries.forEach((p) => {
    if (p && p.date && p.price != null) {
      if (p.date !== lastDate) {
        byDate.push(p);
        lastDate = p.date;
      }
    }
  });

  const weekly = [];
  for (let i = 0; i < byDate.length; i += 7) {
    weekly.push(byDate[i]);
  }
  return weekly;
}

// Developer helper: call this from the browser console to generate an updated
// weekly price history JSON (merged local + live CoinGecko), which you can then
// paste back into data/btcusd-weekly-price-historical.json in the repo.
//
// Example in console:
//   window.exportUpdatedWeeklyHistory().then(() => {})
//
async function exportUpdatedWeeklyHistory(targetElementId) {
  try {
    const [existingWeekly, liveDense] = await Promise.all([
      fetch("./data/btcusd-weekly-price-historical.json").then((r) => r.json()),
      // Try to fetch up to 365 days of recent data for an update slice.
      fetchLiveBtcHistoryFromBlockchain(365),
    ]);

    if (!Array.isArray(existingWeekly) || existingWeekly.length === 0) {
      // eslint-disable-next-line no-console
      console.warn("Existing weekly series is empty or invalid; exporting live-only weekly data.");
      const liveWeeklyOnly = downsampleToApproxWeekly(liveDense);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(liveWeeklyOnly, null, 2));
      return;
    }

    const lastExisting = existingWeekly[existingWeekly.length - 1];
    const lastDateStr = lastExisting.date;
    const lastTime = new Date(`${lastDateStr}T00:00:00Z`).getTime();

    const newSlice = liveDense.filter((p) => {
      const t = new Date(`${p.date}T00:00:00Z`).getTime();
      return t > lastTime;
    });

    const weeklyUpdates = downsampleToApproxWeekly(newSlice);
    const merged = existingWeekly.concat(weeklyUpdates);
    const json = JSON.stringify(merged, null, 2);

    if (targetElementId) {
      const el = document.getElementById(targetElementId);
      if (el) {
        if ("value" in el) {
          el.value = json;
        } else {
          el.textContent = json;
        }
        return;
      }
    }

    // Fallback: log to console.
    // eslint-disable-next-line no-console
    console.log(
      "// Copy this JSON into data/btcusd-weekly-price-historical.json in your repo:\n" +
        json
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("Failed to export updated weekly history", err);
  }
}

// --- BTC vs Bink vs Local P2P chart (daily data) ---
function initBinkPriceChart(dailyPriceData) {
  const canvas = document.getElementById("bink-price-chart");
  if (!canvas) return;

  const binkPriceData = dailyPriceData.map((item) => {
    const price = Number(item.price);
    return {
      date: item.date,
      price,
      binkPrice: Number((price * 0.98).toFixed(2)),
      localP2PPrice: Number((price * 0.96).toFixed(2)),
    };
  });

  const ctx = canvas.getContext("2d");
  // eslint-disable-next-line no-new
  new Chart(ctx, {
    type: "line",
    data: {
      labels: binkPriceData.map((d) => formatDateLabel(d.date)),
      datasets: [
        {
          label: "BTC Price",
          data: binkPriceData.map((d) => d.price),
          borderColor: "#FFA500",
          backgroundColor: "rgba(255,165,0,0.1)",
          borderWidth: 2,
          tension: 0.25,
          pointRadius: 0,
        },
        {
          label: "Bink Price",
          data: binkPriceData.map((d) => d.binkPrice),
          borderColor: "#00FF00",
          backgroundColor: "rgba(0,255,0,0.05)",
          borderWidth: 2,
          tension: 0.25,
          pointRadius: 0,
        },
        {
          label: "Local P2P Price",
          data: binkPriceData.map((d) => d.localP2PPrice),
          borderColor: "#4A90E2",
          backgroundColor: "rgba(74,144,226,0.05)",
          borderWidth: 2,
          tension: 0.25,
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: "#e5e5e5",
          },
        },
        tooltip: {
          callbacks: {
            label(context) {
              const label = context.dataset.label || "";
              const value = context.parsed.y;
              return `${label}: ${formatCurrency(value)}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: "#9ca3af",
            maxRotation: 0,
          },
          grid: {
            color: "#1f2933",
          },
        },
        y: {
          ticks: {
            color: "#9ca3af",
            callback(value) {
              return `$${Number(value).toLocaleString()}`;
            },
          },
          grid: {
            color: "#1f2933",
          },
        },
      },
    },
  });
}

// --- DCA calculator chart (weekly data) ---
function initDcaCalculator(priceData) {
  const weeklyInput = document.getElementById("weekly-amount");
  const frequencyInput = document.getElementById("investment-frequency");
  const timeRangeInput = document.getElementById("time-range");
  const timeRangeLabel = document.getElementById("time-range-label");
  const scaleLinearBtn = document.getElementById("scale-linear");
  const scaleLogBtn = document.getElementById("scale-log");

  const metricInvested = document.getElementById("metric-invested");
  const metricValue = document.getElementById("metric-value");
  const metricBtc = document.getElementById("metric-btc");
  const metricReturn = document.getElementById("metric-return");

  if (
    !weeklyInput ||
    !frequencyInput ||
    !timeRangeInput ||
    !timeRangeLabel ||
    !metricInvested ||
    !metricValue ||
    !metricBtc ||
    !metricReturn
  ) {
    return;
  }

  const maxTimeRange = priceData.length;
  timeRangeInput.max = String(maxTimeRange);

  const startDate = new Date(priceData[0].date);
  const endDate = new Date(priceData[priceData.length - 1].date);
  const totalMonths =
    (endDate.getFullYear() - startDate.getFullYear()) * 12 +
    endDate.getMonth() -
    startDate.getMonth() +
    1;

  function formatTimeRange(months) {
    const years = Math.floor(months / 12);
    const remainingMonths = months % 12;
    if (years === 0) return `${months} month${months !== 1 ? "s" : ""}`;
    if (remainingMonths === 0) {
      return `${years} year${years !== 1 ? "s" : ""}`;
    }
    return `${years} year${years !== 1 ? "s" : ""} ${remainingMonths} month${
      remainingMonths !== 1 ? "s" : ""
    }`;
  }

  function updateTimeRangeLabel(currentWeeks) {
    const months = Math.ceil((currentWeeks * totalMonths) / maxTimeRange);
    timeRangeLabel.textContent = `Time Range: ${formatTimeRange(months)}`;
  }

  updateTimeRangeLabel(Number(timeRangeInput.value || 48));

  const canvas = document.getElementById("dca-chart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  let currentScale = "linear";

  function computeChartData() {
    const weeklyAmountNum = parseFloat(weeklyInput.value || "0");
    const frequencyNum = parseInt(frequencyInput.value || "1", 10) || 1;
    const rangeWeeks = parseInt(timeRangeInput.value || String(maxTimeRange), 10);

    const startIndex = Math.max(priceData.length - rangeWeeks, 0);
    let totalInvested = 0;
    let totalBtc = 0;

    const slice = priceData.slice(startIndex);

    const result = slice.map((item, index) => {
      const price = Number(item.price);
      if (index % frequencyNum === 0) {
        totalInvested += weeklyAmountNum;
        totalBtc += weeklyAmountNum / price;
      }
      const portfolioValue = totalBtc * price;
      return {
        date: item.date,
        price,
        portfolioValue,
        invested: totalInvested,
      };
    });

    return { data: result, latest: result[result.length - 1] || null };
  }

  const { data: initialData, latest: initialLatest } = computeChartData();

  const dcaChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: initialData.map((d) => formatDateLabel(d.date)),
      datasets: [
        {
          label: "BTC Price",
          data: initialData.map((d) => d.price),
          borderColor: "#FFA500",
          backgroundColor: "rgba(255,165,0,0.08)",
          borderWidth: 2,
          tension: 0.25,
          yAxisID: "y",
          pointRadius: 0,
        },
        {
          label: "Portfolio Value",
          data: initialData.map((d) => d.portfolioValue),
          borderColor: "#00FF00",
          backgroundColor: "rgba(0,255,0,0.06)",
          borderWidth: 2,
          tension: 0.25,
          yAxisID: "y1",
          pointRadius: 0,
        },
        {
          label: "Total Invested",
          data: initialData.map((d) => d.invested),
          borderColor: "#4A90E2",
          backgroundColor: "rgba(74,144,226,0.06)",
          borderWidth: 2,
          tension: 0.25,
          yAxisID: "y1",
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: "#e5e5e5",
          },
        },
        tooltip: {
          callbacks: {
            label(context) {
              const label = context.dataset.label || "";
              const value = context.parsed.y;
              return `${label}: ${formatCurrency(value)}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: "#9ca3af",
            maxRotation: 0,
          },
          grid: {
            color: "#1f2933",
          },
        },
        y: {
          type: currentScale,
          position: "left",
          ticks: {
            color: "#9ca3af",
            callback(value) {
              return `$${Number(value).toLocaleString()}`;
            },
          },
          grid: {
            color: "#1f2933",
          },
        },
        y1: {
          type: currentScale,
          position: "right",
          ticks: {
            color: "#9ca3af",
            callback(value) {
              return `$${Number(value).toLocaleString()}`;
            },
          },
          grid: {
            drawOnChartArea: false,
          },
        },
      },
    },
  });

  function updateMetrics(latest) {
    if (!latest) {
      metricInvested.textContent = "$0";
      metricValue.textContent = "$0";
      metricBtc.textContent = "0 BTC";
      metricReturn.textContent = "0%";
      metricReturn.classList.remove("text-green-500", "text-red-500");
      metricReturn.classList.add("text-green-500");
      return;
    }
    const { invested, portfolioValue, price } = latest;
    const btc = price > 0 ? portfolioValue / price : 0;
    const pctGain =
      invested > 0 ? ((portfolioValue - invested) / invested) * 100 : 0;

    metricInvested.textContent = formatCurrency(invested, 0);
    metricValue.textContent = formatCurrency(portfolioValue, 0);
    metricBtc.textContent = `${btc.toFixed(6)} BTC`;

    const pctLabel = `${Math.round(pctGain)}%`;
    metricReturn.textContent = pctLabel;
    metricReturn.classList.remove("text-green-500", "text-red-500");
    metricReturn.classList.add(pctGain >= 0 ? "text-green-500" : "text-red-500");
  }

  updateMetrics(initialLatest);

  function rerenderDcaChart() {
    const { data, latest } = computeChartData();

    dcaChart.data.labels = data.map((d) => formatDateLabel(d.date));
    dcaChart.data.datasets[0].data = data.map((d) => d.price);
    dcaChart.data.datasets[1].data = data.map((d) => d.portfolioValue);
    dcaChart.data.datasets[2].data = data.map((d) => d.invested);

    dcaChart.options.scales.y.type = currentScale;
    dcaChart.options.scales.y1.type = currentScale;

    dcaChart.update();
    updateMetrics(latest);
  }

  weeklyInput.addEventListener("input", rerenderDcaChart);
  frequencyInput.addEventListener("input", rerenderDcaChart);
  timeRangeInput.addEventListener("input", () => {
    const value = parseInt(timeRangeInput.value || "0", 10) || maxTimeRange;
    updateTimeRangeLabel(value);
    rerenderDcaChart();
  });

  if (scaleLinearBtn && scaleLogBtn) {
    scaleLinearBtn.addEventListener("click", () => {
      currentScale = "linear";
      scaleLinearBtn.classList.add("bg-binkCardAlt", "border-neutral-600");
      scaleLogBtn.classList.remove("bg-binkCardAlt", "border-neutral-600");
      rerenderDcaChart();
    });
    scaleLogBtn.addEventListener("click", () => {
      currentScale = "log";
      scaleLogBtn.classList.add("bg-binkCardAlt", "border-neutral-600");
      scaleLinearBtn.classList.remove("bg-binkCardAlt", "border-neutral-600");
      rerenderDcaChart();
    });
  }
}

// --- Stacker dashboard demo (reusing weekly data) ---
function initStackerDashboard(priceData) {
  const canvas = document.getElementById("stacker-dashboard-chart");
  const tableBody = document.getElementById("stacker-purchase-table");
  const totalInvestedEl = document.getElementById("stacker-total-invested");
  const currentValueEl = document.getElementById("stacker-current-value");
  const profitEl = document.getElementById("stacker-profit");
  const profitPctEl = document.getElementById("stacker-profit-pct");

  if (
    !canvas ||
    !tableBody ||
    !totalInvestedEl ||
    !currentValueEl ||
    !profitEl ||
    !profitPctEl
  ) {
    return;
  }

  // Generate simple demo DCA data: $200 every 2 weeks from 2021-04-16 to last date
  const startDate = new Date("2021-04-16");
  const endDate = new Date(priceData[priceData.length - 1].date);

  const data = [];
  let totalInvested = 0;
  let totalBtc = 0;

  priceData.forEach((p, index) => {
    const current = new Date(p.date);
    if (current < startDate || current > endDate) return;

    if (index % 2 === 0) {
      totalInvested += 200;
      totalBtc += 200 / Number(p.price);
    }

    data.push({
      date: p.date,
      price: Number(p.price),
      invested: totalInvested,
      portfolioValue: totalBtc * Number(p.price),
    });
  });

  const latest = data[data.length - 1];
  if (!latest) return;

  totalInvestedEl.textContent = formatCurrency(latest.invested, 0);
  currentValueEl.textContent = formatCurrency(latest.portfolioValue, 0);

  const profit = latest.portfolioValue - latest.invested;
  const pct = (profit / latest.invested) * 100;

  profitEl.textContent = formatCurrency(Math.abs(profit), 0);
  profitPctEl.textContent = `${Math.round(pct)}%`;
  profitEl.classList.remove("text-green-500", "text-red-500");
  profitPctEl.classList.remove("text-green-500", "text-red-500");
  if (profit >= 0) {
    profitEl.classList.add("text-green-500");
    profitPctEl.classList.add("text-green-500");
  } else {
    profitEl.classList.add("text-red-500");
    profitPctEl.classList.add("text-red-500");
  }

  // Fill recent purchases table (last 5 buy events)
  const purchases = data.filter((_, idx) => idx % 2 === 0).slice(-5).reverse();
  tableBody.innerHTML = "";
  purchases.forEach((t) => {
    const btcAmount = 200 / t.price;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="py-1 pr-4">${formatDateLabel(t.date)}</td>
      <td class="py-1 pr-4">$200.00</td>
      <td class="py-1 pr-4">${formatCurrency(t.price, 2)}</td>
      <td class="py-1 pr-4">${btcAmount.toFixed(8)} BTC</td>
      <td class="py-1">
        <span class="px-2 py-1 rounded-full text-xs bg-green-500 text-black">Completed</span>
      </td>
    `;
    tableBody.appendChild(tr);
  });

  const ctx = canvas.getContext("2d");
  // eslint-disable-next-line no-new
  new Chart(ctx, {
    type: "line",
    data: {
      labels: data.map((d) => formatDateLabel(d.date)),
      datasets: [
        {
          label: "BTC Price",
          data: data.map((d) => d.price),
          borderColor: "#FFA500",
          borderWidth: 2,
          tension: 0.25,
          pointRadius: 0,
          yAxisID: "y",
        },
        {
          label: "Portfolio Value",
          data: data.map((d) => d.portfolioValue),
          borderColor: "#00FF00",
          borderWidth: 2,
          tension: 0.25,
          pointRadius: 0,
          yAxisID: "y1",
        },
        {
          label: "Total Invested",
          data: data.map((d) => d.invested),
          borderColor: "#4A90E2",
          borderWidth: 2,
          tension: 0.25,
          pointRadius: 0,
          yAxisID: "y1",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          labels: {
            color: "#e5e5e5",
          },
        },
        tooltip: {
          callbacks: {
            label(context) {
              const label = context.dataset.label || "";
              const value = context.parsed.y;
              return `${label}: ${formatCurrency(value)}`;
            },
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: "#9ca3af",
            maxRotation: 0,
          },
          grid: {
            color: "#1f2933",
          },
        },
        y: {
          position: "left",
          ticks: {
            color: "#9ca3af",
            callback(value) {
              return `$${Number(value).toLocaleString()}`;
            },
          },
          grid: {
            color: "#1f2933",
          },
        },
        y1: {
          position: "right",
          ticks: {
            color: "#9ca3af",
            callback(value) {
              return `$${Number(value).toLocaleString()}`;
            },
          },
          grid: {
            drawOnChartArea: false,
          },
        },
      },
    },
  });
}

