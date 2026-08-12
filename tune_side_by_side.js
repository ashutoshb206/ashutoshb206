const fs = require('fs');

async function fetchFromGraphQL(username, year, token) {
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const query = `
    query($username: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $username) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            weeks {
              contributionDays {
                date
                contributionCount
              }
            }
          }
        }
      }
    }
  `;
  const from = `${year}-01-01T00:00:00Z`;
  const to = `${year}-12-31T23:59:59Z`;
  
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Node.js'
    },
    body: JSON.stringify({ query, variables: { username, from, to } })
  });

  if (res.ok) {
    const json = await res.json();
    const weeks = json.data?.user?.contributionsCollection?.contributionCalendar?.weeks;
    if (weeks && Array.isArray(weeks)) {
      const monthsData = {};
      weeks.forEach(w => {
        w.contributionDays.forEach(d => {
          const monthIdx = parseInt(d.date.substring(5, 7), 10) - 1;
          const monthName = monthNames[monthIdx];
          monthsData[monthName] = (monthsData[monthName] || 0) + d.contributionCount;
        });
      });
      return monthsData;
    }
  }
  return null;
}

async function updateCharts() {
  const now = new Date();
  const year = now.getFullYear();
  const currentMonthIdx = now.getMonth();
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  
  // Elapsed months up to current month of current year
  const months = monthNames.slice(0, currentMonthIdx + 1);

  // Cached fallback counts if network fails
  let monthlyCounts = { Jan: 3, Feb: 85, Mar: 112, Apr: 115, May: 8, Jun: 44, Jul: 310, Aug: 134 };

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  let fetchedData = null;

  if (token) {
    try {
      fetchedData = await fetchFromGraphQL('ashutoshb206', year, token);
    } catch (e) {
      console.log('GraphQL fetch failed, trying public API:', e.message);
    }
  }

  if (!fetchedData) {
    try {
      const res = await fetch(`https://github-contributions-api.jogruber.de/v4/ashutoshb206?y=${year}`);
      if (res.ok) {
        const data = await res.json();
        if (data.contributions) {
          const monthsData = {};
          data.contributions.forEach(item => {
            const monthIdx = parseInt(item.date.substring(5, 7), 10) - 1;
            const monthName = monthNames[monthIdx];
            monthsData[monthName] = (monthsData[monthName] || 0) + item.count;
          });
          fetchedData = monthsData;
        }
      }
    } catch (err) {
      console.log('Using cached contribution data:', err.message);
    }
  }

  if (fetchedData) {
    monthlyCounts = fetchedData;
  }

  const monthDataList = [];
  let runningTotal = 0;

  months.forEach(m => {
    const count = monthlyCounts[m] || 0;
    runningTotal += count;
    monthDataList.push({ month: m, count, total: runningTotal });
  });

  const rawMax = Math.max(600, runningTotal);
  const maxTotal = Math.ceil(rawMax / 100) * 100;

  // Calculate coordinates for 600x480 SVG (Origin x=80, y=410, Y-height=330, X-width=460)
  const startX = 80;
  const endX = 540;
  const dx = months.length > 1 ? (endX - startX) / (months.length - 1) : 0;

  const points = monthDataList.map((d, i) => {
    const x = startX + i * dx;
    const y = 410 - (d.total / maxTotal) * 330;
    return { ...d, x, y };
  });

  const pathD = points.length === 1 
    ? `M ${points[0].x} ${points[0].y.toFixed(1)}` 
    : `M ${points[0].x} ${points[0].y.toFixed(1)} ` + points.slice(1).map((p, i) => {
        const prev = points[i];
        const segDx = p.x - prev.x;
        const cx1 = prev.x + segDx * 0.35;
        const cy1 = prev.y;
        const cx2 = p.x - segDx * 0.35;
        const cy2 = p.y;
        return `C ${cx1.toFixed(1)} ${cy1.toFixed(1)}, ${cx2.toFixed(1)} ${cy2.toFixed(1)}, ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
      }).join(' ');

  const nodesSvg = points.map((p, i) => {
    const isLatest = i === points.length - 1;
    const circleRadius = isLatest ? 7 : 5;
    const labelText = isLatest ? `${p.month} ${year}: +${p.count} (${p.total} Total!)` : `${p.month} ${year}: +${p.count} (${p.total} Total)`;
    const tooltipWidth = isLatest ? 170 : 160;
    const tooltipX = isLatest ? (p.x > 450 ? p.x - 80 : p.x) : p.x;
    
    return `
    <g class="node-group">
      <title>${p.month} ${year}: +${p.count} commits (${p.total} total)</title>
      <text x="${p.x.toFixed(1)}" y="${(p.y - 12).toFixed(1)}" class="stat-num" text-anchor="middle">${p.total}</text>
      <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${circleRadius}" class="node-dot" fill="#DC2626"/>
      <g class="tooltip-box" transform="translate(${tooltipX.toFixed(1)}, ${(p.y - 38).toFixed(1)})">
        <rect x="-${tooltipWidth / 2}" y="-16" width="${tooltipWidth}" height="30" rx="5" fill="#0F172A" fill-opacity="0.95" ${isLatest ? 'stroke="#DC2626" stroke-width="1.5"' : ''}/>
        <text x="0" y="4" font-size="12" font-weight="700" fill="${isLatest ? '#22C55E' : '#FFFFFF'}" text-anchor="middle">${labelText}</text>
      </g>
    </g>`;
  }).join('\n');

  // Dynamic Y-axis ticks (6 ticks)
  const numTicks = 6;
  const yTicksSvg = [];
  for (let k = 0; k <= numTicks; k++) {
    const val = Math.round((maxTotal / numTicks) * k);
    const yPos = 410 - (val / maxTotal) * 330;
    yTicksSvg.push(`
    <text x="46" y="${(yPos + 4).toFixed(1)}" class="axis-num" text-anchor="end">${val}</text>
    <line x1="54" y1="${yPos.toFixed(1)}" x2="64" y2="${yPos.toFixed(1)}" stroke="#0F172A" stroke-width="2"/>
    ${k > 0 ? `<line x1="60" y1="${yPos.toFixed(1)}" x2="560" y2="${yPos.toFixed(1)}" stroke="#E2E8F0" stroke-width="1" stroke-dasharray="4,4"/>` : ''}
    `);
  }

  const lineSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 480" width="600" height="480" style="background: #FFFFFF;">
  <defs>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Comic+Neue:wght@400;700&amp;family=Shantell+Sans:wght@500;700;800&amp;display=swap');

      .handwritten {
        font-family: 'Comic Neue', 'Shantell Sans', 'Comic Sans MS', cursive, sans-serif;
      }
      .chart-title {
        fill: #0F172A;
        font-size: 21px;
        font-weight: 700;
      }
      .axis-label {
        fill: #334155;
        font-size: 15px;
        font-weight: 700;
      }
      .axis-num {
        fill: #64748B;
        font-size: 13px;
        font-weight: 700;
      }
      .stat-num {
        fill: #DC2626;
        font-size: 13px;
        font-weight: 700;
        opacity: 0.85;
        transition: opacity 0.2s ease, font-size 0.2s ease;
      }
      .node-group {
        cursor: pointer;
      }
      .tooltip-box {
        opacity: 0;
        transition: opacity 0.2s ease-in-out, transform 0.2s ease-in-out;
        pointer-events: none;
      }
      .node-group:hover .tooltip-box {
        opacity: 1;
      }
      .node-dot {
        transition: r 0.2s ease, fill 0.2s ease;
      }
      .node-group:hover .node-dot {
        r: 8;
        fill: #991B1B;
      }
      .node-group:hover .stat-num {
        opacity: 1;
        font-size: 15px;
        fill: #991B1B;
      }
    </style>
  </defs>

  <g class="handwritten">
    <text x="300" y="36" class="chart-title" text-anchor="middle">contributions / ${year} (Live Data)</text>

    <g transform="translate(50, 52)">
      <rect x="0" y="0" width="130" height="28" rx="6" fill="#FFFFFF" stroke="#0F172A" stroke-width="2"/>
      <rect x="10" y="9" width="10" height="10" rx="2" fill="#DC2626"/>
      <text x="28" y="19" font-size="13" font-weight="700" fill="#0F172A">Commits &amp; PRs</text>
    </g>

    <path d="M 58 411 Q 300 413 560 410" fill="none" stroke="#0F172A" stroke-width="3" stroke-linecap="round"/>
    <path d="M 60 412 Q 59 230 60 80" fill="none" stroke="#0F172A" stroke-width="3" stroke-linecap="round"/>

    ${yTicksSvg.join('\n')}

    ${points.map(p => `<text x="${p.x.toFixed(1)}" y="434" class="axis-label" text-anchor="middle">${p.month}</text>`).join('\n')}

    <path d="${pathD}" fill="none" stroke="#DC2626" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="${pathD}" fill="none" stroke="transparent" stroke-width="25" stroke-linecap="round"/>

    ${nodesSvg}

  </g>
</svg>`;

  fs.writeFileSync('contribution-chart.svg', lineSvg);
  console.log('Dynamic auto-updating contribution-chart.svg successfully generated!');
}

updateCharts();

