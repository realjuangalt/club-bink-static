// DCA calculator & stacker dashboard logic

// Fetch recent BTC/USD daily prices from Blockchain.com's free charts API
// and normalize into [{ date, price }] to match the existing calculator logic.
// Docs: https://www.blockchain.com/api/charts_api
async function fetchLiveBtcHistoryFromBlockchain(days = 365) {
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

// --- DCA calculator chart (weekly data) ---
function initDcaCalculator(priceData) {
  const weeklyInput = document.getElementById("weekly-amount");
  const frequencyInput = document.getElementById("investment-frequency");
  const timeRangeStartInput = document.getElementById("time-range-start");
  const timeRangeEndInput = document.getElementById("time-range-end");
  const timeRangeLabel = document.getElementById("time-range-label");
  const timeRangeSummary = document.getElementById("time-range-summary");
  const scaleLinearBtn = document.getElementById("scale-linear");
  const scaleLogBtn = document.getElementById("scale-log");

  const metricInvested = document.getElementById("metric-invested");
  const metricValue = document.getElementById("metric-value");
  const metricBtc = document.getElementById("metric-btc");
  const metricReturn = document.getElementById("metric-return");

  if (
    !weeklyInput ||
    !frequencyInput ||
    !timeRangeStartInput ||
    !timeRangeEndInput ||
    !timeRangeLabel ||
    !timeRangeSummary ||
    !metricInvested ||
    !metricValue ||
    !metricBtc ||
    !metricReturn
  ) {
    return;
  }

  const maxIndex = priceData.length - 1;
  timeRangeStartInput.min = "0";
  timeRangeStartInput.max = String(maxIndex);
  timeRangeEndInput.min = "0";
  timeRangeEndInput.max = String(maxIndex);

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

  function updateTrackBackground(startIdx, endIdx) {
    if (!Number.isFinite(maxIndex) || maxIndex <= 0) return;
    const startPct = (startIdx / maxIndex) * 100;
    const endPct = (endIdx / maxIndex) * 100;
    const gray = "#4b5563"; // tailwind gray-700
    const orange = "#f97316"; // approx bink orange
    timeRangeStartInput.style.background = `linear-gradient(to right,
      ${gray} 0%,
      ${gray} ${startPct}%,
      ${orange} ${startPct}%,
      ${orange} ${endPct}%,
      ${gray} ${endPct}%,
      ${gray} 100%
    )`;
  }

  function updateTimeRangeLabel(startIdx, endIdx) {
    const start = priceData[startIdx] ? new Date(priceData[startIdx].date) : startDate;
    const end = priceData[endIdx] ? new Date(priceData[endIdx].date) : endDate;

    const months =
      (end.getFullYear() - start.getFullYear()) * 12 +
      (end.getMonth() - start.getMonth()) +
      1;

    timeRangeSummary.textContent = `${start.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
    })} → ${end.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
    })} • ${formatTimeRange(Math.max(months, 1))}`;
    updateTrackBackground(startIdx, endIdx);
  }

  // Default view: from ~2014 (or earliest available) to the latest point.
  let defaultStartIndex = 0;
  for (let i = 0; i < priceData.length; i += 1) {
    if (priceData[i] && priceData[i].date >= "2014-01-01") {
      defaultStartIndex = i;
      break;
    }
  }
  let defaultEndIndex = maxIndex;

  timeRangeStartInput.value = String(defaultStartIndex);
  timeRangeEndInput.value = String(defaultEndIndex);
  updateTimeRangeLabel(defaultStartIndex, defaultEndIndex);

  const canvas = document.getElementById("dca-chart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  // Chart.js expects "linear" or "logarithmic" here.
  let currentScale = "linear";
  // Minimum visible time window ~6 months.
  const minMonthsWindow = 6;
  const indicesPerMonth = maxIndex > 0 ? maxIndex / totalMonths : 0;
  const minIndexSpan =
    indicesPerMonth > 0
      ? Math.max(1, Math.round(minMonthsWindow * indicesPerMonth))
      : 1;

  function computeChartData() {
    const weeklyAmountNum = parseFloat(weeklyInput.value || "0");
    const frequencyNum = parseInt(frequencyInput.value || "1", 10) || 1;
    let startIndex = parseInt(timeRangeStartInput.value || "0", 10) || 0;
    let endIndex = parseInt(timeRangeEndInput.value || String(maxIndex), 10);

    startIndex = Math.max(0, Math.min(startIndex, maxIndex));
    endIndex = Math.max(0, Math.min(endIndex, maxIndex));
    if (endIndex < startIndex) {
      [startIndex, endIndex] = [endIndex, startIndex];
    }

    updateTimeRangeLabel(startIndex, endIndex);
    let totalInvested = 0;
    let totalBtc = 0;

    const slice = priceData.slice(startIndex, endIndex + 1);

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
  const handleRangeChange = (changed) => {
    let startIndex = parseInt(timeRangeStartInput.value || "0", 10) || 0;
    let endIndex = parseInt(timeRangeEndInput.value || String(maxIndex), 10);

    startIndex = Math.max(0, Math.min(startIndex, maxIndex));
    endIndex = Math.max(0, Math.min(endIndex, maxIndex));

    if (endIndex < startIndex) {
      if (changed === "start") {
        startIndex = endIndex - minIndexSpan;
      } else {
        endIndex = startIndex + minIndexSpan;
      }
    }

    if (endIndex - startIndex < minIndexSpan) {
      if (changed === "start") {
        startIndex = Math.max(0, endIndex - minIndexSpan);
      } else {
        endIndex = Math.min(maxIndex, startIndex + minIndexSpan);
      }
    }

    timeRangeStartInput.value = String(startIndex);
    timeRangeEndInput.value = String(endIndex);
    rerenderDcaChart();
  };
  timeRangeStartInput.addEventListener("input", () => handleRangeChange("start"));
  timeRangeEndInput.addEventListener("input", () => handleRangeChange("end"));

  if (scaleLinearBtn && scaleLogBtn) {
    scaleLinearBtn.addEventListener("click", () => {
      currentScale = "linear";
      scaleLinearBtn.classList.add("bg-binkCardAlt", "border-neutral-600");
      scaleLogBtn.classList.remove("bg-binkCardAlt", "border-neutral-600");
      rerenderDcaChart();
    });
    scaleLogBtn.addEventListener("click", () => {
      currentScale = "logarithmic";
      scaleLogBtn.classList.add("bg-binkCardAlt", "border-neutral-600");
      scaleLinearBtn.classList.remove("bg-binkCardAlt", "border-neutral-600");
      rerenderDcaChart();
    });
  }
}

// --- Stacker dashboard demo (reusing same price data) ---
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

// Attach a DCA bootstrapper on DOMContentLoaded so this file is standalone.
document.addEventListener("DOMContentLoaded", () => {
  if (typeof Chart === "undefined") return;

  fetchLiveBtcHistoryFromBlockchain()
    .then((livePriceData) => {
      initDcaCalculator(livePriceData);
      initStackerDashboard(livePriceData);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("Error loading live BTC data, falling back to bundled weekly JSON", err);
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

