import assert from "node:assert/strict";
import {chromium} from "playwright";
import {answerWebpage}
  from "../src/agent/webpage-answer.js";
import {answerTableRow34G}
  from "../src/agent/table-row-answer-34G.js";

const task=
  'On the current page, inspect Table 1 and find the row '+
  'where the first name is "Jason" and the last name is "Doe". '+
  'Read his email address, Due amount, and Website. '+
  'Report these three values exactly as shown. '+
  'Do not click Edit or Delete, do not modify any data, '+
  'and do not navigate away. Report success only if all '+
  'three values are confirmed from the actual table.';

const headers=
  '<thead><tr><th>Last Name</th><th>First Name</th>'+
  '<th>Email</th><th>Due</th><th>Web Site</th>'+
  '<th>Action</th></tr></thead>';

const row=
  '<tr><td>Doe</td><td>Jason</td>'+
  '<td>jdoe@hotmail.com</td><td>$100.00</td>'+
  '<td>http://www.jdoe.com</td><td>edit</td></tr>';

const html=(rows=row)=>`
<html><head><title>Tables</title></head><body>
<table>${headers}<tbody>${rows}</tbody></table>
<table>${headers}<tbody>
<tr><td>Doe</td><td>Jason</td>
<td>wrong@example.org</td><td>$999.00</td>
<td>http://wrong.example.org</td><td>edit</td></tr>
</tbody></table></body></html>`;

const browser=await chromium.launch({headless:true});

try{
  const page=await browser.newPage();

  await page.route(
    "https://example.org/verified-table",
    route=>route.fulfill({
      contentType:"text/html",
      body:html()
    })
  );

  await page.goto("https://example.org/verified-table");

  let modelCalls=0;
  const result=await answerWebpage(page,task,{
    fetchImpl:async()=>{
      modelCalls++;
      throw new Error("Unexpected model call");
    }
  });

  assert.equal(result.status,"answer_ready");
  assert.equal(
    result.answer,
    "Email: jdoe@hotmail.com\n"+
    "Due: $100.00\n"+
    "Web Site: http://www.jdoe.com"
  );
  assert.equal(
    result.evidence.method,
    "verified_dom_table_row"
  );
  assert.equal(modelCalls,0);

  console.log("PASS: Exact three-column result");
  console.log("PASS: Correct table and same-row identity");
  console.log("PASS: No model-generated values");

  async function reject(body,instruction=task){
    await page.setContent(body);
    const result=await answerTableRow34G(page,instruction);
    assert.equal(result.status,"answer_unavailable");
  }

  await reject(html(
    row.replace("<td>Jason</td>","<td>Janet</td>")
  ));
  console.log("PASS: Missing row rejected");

  await reject(html(row+row));
  console.log("PASS: Duplicate row rejected");

  await reject(
    html(),task.replace("Table 1","Table 3")
  );
  console.log("PASS: Wrong table rejected");

  await reject(
    html(),task.replace("Due amount","Unknown Column")
  );
  console.log("PASS: Missing column rejected");

  await reject(
    html(),task.replace("Website","Email")
  );
  console.log("PASS: Duplicate requested column rejected");

  await page.setContent(html());

  assert.equal(
    await answerTableRow34G(
      page,
      "Explain her contributions using introductory text."
    ),
    null
  );

  console.log("PASS: Unrelated reading path unaffected");
  console.log("PASS: Step 7F.34G local test");

}finally{
  await browser.close();
}
