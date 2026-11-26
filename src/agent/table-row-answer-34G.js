function norm(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\bweb[\s_-]*site\b/g,"website")
    .replace(/\be[\s-]?mail(?:\s+address)?\b/g,"email")
    .replace(/\bdue\s+amount\b/g,"due")
    .replace(/[^a-z0-9]+/g," ")
    .trim();
}

function requestedName(text,type) {
  return text.match(new RegExp(
    "\\b"+type+
    "\\s+name\\s+(?:is|equals)\\s*"+
    "[\"'“‘]([^\"'“”‘’]{1,100})[\"'”’]","i"
  ))?.[1]?.trim() ?? null;
}

const unavailable=reason=>({
  status:"answer_unavailable",reason
});

export async function answerTableRow34G(page,instruction) {
  const text=String(instruction ?? "");
  const tableMatch=text.match(/\btable\s+(\d{1,2})\b/i);
  const first=requestedName(text,"first");
  const last=requestedName(text,"last");

  // Only this explicit table-person request uses this path.
  // All other webpage reading remains unchanged.
  if (!tableMatch || !first || !last) return null;

  const tableNumber=Number(tableMatch[1]);
  const read=text.match(
    /\b(?:read|extract|report|provide|return|show|give)\s+([^.!?;\n]{1,250})/i
  )?.[1];

  if (!read) return unavailable("No requested columns.");

  const requested=read
    .split(/\s*,\s*|\s+\band\s+/i)
    .map(part=>part.replace(
      /^(?:(?:his|her|their|its|the|and)\s+)+/i,""
    ))
    .map(norm)
    .filter(Boolean);

  if (
    !requested.length ||
    requested.length>8 ||
    new Set(requested).size!==requested.length
  ) {
    return unavailable("Ambiguous requested columns.");
  }

  const originalUrl=page.url();

  if (!/^https?:\/\//i.test(originalUrl)) {
    return unavailable("Verified webpage URL required.");
  }

  const evidence=await page.evaluate(
    ({tableNumber,first,last})=>{
      const visible=el=>el.getClientRects().length>0;

      const tables=[
        ...document.querySelectorAll("table")
      ].filter(visible);

      const table=tables[tableNumber-1];
      if (!table) return {reason:"TABLE_NOT_FOUND"};

      const headers=[
        ...table.querySelectorAll("thead tr:first-child th")
      ].map(el=>el.innerText.trim());

      const clean=value=>String(value ?? "")
        .toLowerCase().replace(/\s+/g," ").trim();

      const firstIndex=headers.findIndex(
        value=>clean(value)==="first name"
      );
      const lastIndex=headers.findIndex(
        value=>clean(value)==="last name"
      );

      if (firstIndex<0 || lastIndex<0 || headers.length<3) {
        return {reason:"IDENTITY_COLUMNS_MISSING"};
      }

      const rows=[
        ...table.querySelectorAll("tbody tr")
      ].filter(visible);

      if (rows.length>200) {
        return {reason:"TABLE_TOO_LARGE_TO_VERIFY"};
      }

      const matches=rows.map(row=>
        [...row.cells].map(cell=>cell.innerText.trim())
      ).filter(cells=>
        cells.length===headers.length &&
        clean(cells[firstIndex])===clean(first) &&
        clean(cells[lastIndex])===clean(last)
      );

      return {headers,matches};
    },
    {tableNumber,first,last}
  );

  if (page.url()!==originalUrl) {
    return unavailable("Page changed during inspection.");
  }

  if (evidence.reason) {
    return unavailable(evidence.reason);
  }

  if (evidence.matches.length!==1) {
    return unavailable(
      evidence.matches.length===0
        ? "Requested row not found."
        : "Multiple matching rows."
    );
  }

  const headers=evidence.headers.map(norm);
  const cells=evidence.matches[0];

  const indices=requested.map(field=>{
    const found=headers.flatMap((header,index)=>
      header===field?[index]:[]
    );
    return found.length===1?found[0]:null;
  });

  if (
    indices.some(index=>index===null) ||
    new Set(indices).size!==indices.length
  ) {
    return unavailable("Requested columns not uniquely found.");
  }

  if (indices.some(index=>
    !String(cells[index] ?? "").trim()
  )) {
    return unavailable("Requested cell is empty.");
  }

  const answer=indices.map(index=>
    `${evidence.headers[index]}: ${cells[index]}`
  ).join("\n");

  const title=await page.title();

  if (page.url()!==originalUrl) {
    return unavailable("Page changed before answer delivery.");
  }

  return {
    status:"answer_ready",
    answer,
    sourceUrl:originalUrl,
    sourceTitle:title,
    evidence:{
      method:"verified_dom_table_row",
      tableNumber,
      firstName:first,
      lastName:last,
      matchingRows:1,
      verifiedColumns:indices.map(i=>evidence.headers[i]),
      modelUsedForAnswer:false
    }
  };
}
