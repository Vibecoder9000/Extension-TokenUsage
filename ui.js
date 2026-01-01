// Token Usage Tracker - UI Module
// Chart visualization and frontend logic

// --- Mock Data Generation ---
function generateMockData(days) {
  const data = [];
  const today = new Date();
  
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    
    const dateSeed = date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
    const randomFactor = (Math.sin(dateSeed) + 1) / 2;
    const isWeekend = date.getDay() === 0 || date.getDay() === 6;
    
    let usage = isWeekend ? 1500 : 5000;
    usage += Math.floor(randomFactor * 2500);

    const dayIndex = Math.floor(date.getTime() / (1000 * 60 * 60 * 24));

    if (dayIndex % 37 === 0) {
      usage += 45000;
    } else if (dayIndex % 11 === 0) {
      usage += 15000; 
    } else if (dayIndex % 5 === 0 && !isWeekend) {
       usage += 5000;
    }

    data.push({
      date: date,
      usage: usage,
      displayDate: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date),
      fullDate: new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(date)
    });
  }
  return data;
}

// --- App State ---
let currentRange = 30;
let chartData = [];
const container = document.getElementById('chart-container');
const tooltip = document.getElementById('tooltip');
const tooltipDate = document.getElementById('tooltip-date');
const tooltipUsage = document.getElementById('tooltip-usage');

// --- Style Constants ---
const COLORS = {
  bar: '#6366f1',      // indigo-500
  text: '#64748b',     // slate-500
  grid: '#e2e8f0',     // slate-200
  cursor: '#f1f5f9'    // slate-100
};

// --- SVG Helpers ---
const NS = "http://www.w3.org/2000/svg";

function createSVGElement(type, attrs = {}) {
  const el = document.createElementNS(NS, type);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, value);
  }
  return el;
}

function formatNumber(num) {
  if (num >= 1000) return `${(num / 1000).toFixed(0)}k`;
  return num.toString();
}

function formatNumberFull(num) {
  return new Intl.NumberFormat('en-US').format(num);
}

// --- Chart Rendering ---
function renderChart() {
  container.innerHTML = '';
  const { width, height } = container.getBoundingClientRect();
  
  if (width === 0 || height === 0) return;

  // Dimensions
  const margin = { top: 10, right: 10, bottom: 25, left: 50 };
  const chartWidth = width - margin.left - margin.right;
  const chartHeight = height - margin.top - margin.bottom;

  const svg = createSVGElement('svg', {
    width: width,
    height: height,
    viewBox: `0 0 ${width} ${height}`,
    style: 'display: block;'
  });

  // Layer Groups
  const cursorGroup = createSVGElement('g', { class: 'cursors' });
  const gridGroup = createSVGElement('g', { class: 'grid' });
  const barGroup = createSVGElement('g', { class: 'bars' });
  const textGroup = createSVGElement('g', { class: 'labels' });
  
  svg.appendChild(cursorGroup);
  svg.appendChild(gridGroup);
  svg.appendChild(barGroup);
  svg.appendChild(textGroup);

  // Y Scale Logic
  const maxUsage = Math.max(...chartData.map(d => d.usage));
  const roughStep = maxUsage / 4; 
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  let step = Math.ceil(roughStep / magnitude) * magnitude;
  
  if (step / magnitude < 1.5) step = 1 * magnitude;
  else if (step / magnitude < 3) step = 2.5 * magnitude; 
  else if (step / magnitude < 7) step = 5 * magnitude;
  else step = 10 * magnitude;
  
  let niceMax = Math.ceil(maxUsage / step) * step;
  if (niceMax === 0) niceMax = 5000;
  
  const yScale = (val) => chartHeight - (val / niceMax) * chartHeight;

  // Draw Grid and Y Axis
  for (let val = 0; val <= niceMax; val += step) {
    const y = margin.top + yScale(val);

    // Grid Line
    const line = createSVGElement('line', {
        x1: margin.left,
        y1: y,
        x2: width - margin.right,
        y2: y,
        stroke: COLORS.grid,
        'stroke-width': '1',
        'stroke-dasharray': '4 4'
    });
    gridGroup.appendChild(line);

    // Y Axis Label
    const text = createSVGElement('text', {
      x: margin.left - 10,
      y: y + 4,
      'text-anchor': 'end',
      fill: COLORS.text,
      'font-size': '12',
      'font-family': 'ui-sans-serif, system-ui, sans-serif'
    });
    text.textContent = formatNumber(val);
    textGroup.appendChild(text);
  }

  // Draw Bars, Cursors, and X Axis
  const barGapPct = 0.02; // 2% gap
  const totalBarWidth = chartWidth / chartData.length;
  
  let barWidth = totalBarWidth * (1 - barGapPct);
  if (barWidth > 80) barWidth = 80;
  
  const actualGap = totalBarWidth - barWidth;
  let labelInterval = currentRange === 90 ? 6 : currentRange === 30 ? 2 : 1;

  chartData.forEach((d, i) => {
    const slotX = margin.left + (i * totalBarWidth);
    const barX = slotX + (actualGap / 2);
    
    const barH = (d.usage / niceMax) * chartHeight;
    const barY = margin.top + (chartHeight - barH);

    // Hover Cursor
    const cursor = createSVGElement('rect', {
      x: slotX,
      y: margin.top,
      width: totalBarWidth,
      height: chartHeight,
      fill: 'transparent', 
      class: 'cursor-rect'
    });
    
    cursor.addEventListener('mouseenter', () => {
      cursor.setAttribute('fill', COLORS.cursor);
      tooltipDate.textContent = d.fullDate;
      tooltipUsage.textContent = `${formatNumberFull(d.usage)} tokens`;
      tooltip.classList.remove('hidden');
    });

    cursor.addEventListener('mousemove', (e) => {
      const tipX = e.clientX + 15;
      const tipY = e.clientY - 10;
      tooltip.style.transform = `translate(${tipX}px, ${tipY}px)`;
    });

    cursor.addEventListener('mouseleave', () => {
      cursor.setAttribute('fill', 'transparent');
      tooltip.classList.add('hidden');
    });

    cursorGroup.appendChild(cursor);

    // Bar Shape
    const r = 4;
    const h = Math.max(0, barH);
    const w = barWidth;
    
    let pathD;
    if (h < r) {
         pathD = `M ${barX},${barY+h} v-${h} h${w} v${h} z`;
    } else {
        pathD = `
          M ${barX},${barY + h}
          v -${h - r}
          a ${r},${r} 0 0 1 ${r},-${r}
          h ${w - 2 * r}
          a ${r},${r} 0 0 1 ${r},${r}
          v ${h - r}
          z
        `;
    }

    const path = createSVGElement('path', {
      d: pathD,
      fill: COLORS.bar,
      'shape-rendering': 'geometricPrecision',
      'pointer-events': 'none'
    });
    barGroup.appendChild(path);

    // X Axis Label
    if (i % labelInterval === 0) {
      const labelX = barX + barWidth / 2;
      const labelY = height - 5; 
      const label = createSVGElement('text', {
        x: labelX,
        y: labelY,
        'text-anchor': 'middle',
        fill: COLORS.text,
        'font-size': '12',
        'font-family': 'ui-sans-serif, system-ui, sans-serif'
      });
      label.textContent = d.displayDate;
      textGroup.appendChild(label);
    }
  });

  container.appendChild(svg);
}

function update(range) {
  currentRange = range;
  chartData = generateMockData(range);
  renderChart();
  
  document.querySelectorAll('.range-btn').forEach(btn => {
    const val = parseInt(btn.getAttribute('data-value'));
    if (val === range) {
      btn.classList.add('active');
      btn.classList.remove('text-slate-500', 'hover:text-slate-700', 'hover:bg-slate-200/50');
    } else {
      btn.classList.remove('active');
      btn.classList.add('text-slate-500', 'hover:text-slate-700', 'hover:bg-slate-200/50');
    }
  });
}

document.getElementById('range-selector').addEventListener('click', (e) => {
  if (e.target.classList.contains('range-btn')) {
    update(parseInt(e.target.getAttribute('data-value')));
  }
});

let resizeTimeout;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(renderChart, 100);
});

update(30);
