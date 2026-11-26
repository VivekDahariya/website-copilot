import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { buildProductPriceComparison } from '../src/agent/autonomous-workflow.js';
import { extractGenericInformation } from '../src/agent/generic-information-extractor.js';
import { validateExtraction } from '../src/agent/extraction-validator.js';

const browser=await chromium.launch({headless:true,
  ...(process.env.WC_TEST_CHROMIUM ? {executablePath:process.env.WC_TEST_CHROMIUM} : {}),
  args:['--no-sandbox']});
try {
  const page=await browser.newPage();
  async function product(title, price, availability) {
    await page.setContent(`<!doctype html><title>${title}</title><main><h1>${title}</h1><p>${price}</p><p>${availability}</p></main>`);
    const record=await extractGenericInformation(page);
    const validation=validateExtraction(record);
    assert.equal(validation.valid,true,JSON.stringify(validation));
    assert.equal(record.price,price);
    return record;
  }
  const pounds=await product('Book One','£20.00','In stock');
  const rupees=await product('Book Two','₹500.00','In stock');
  const mixed=buildProductPriceComparison([pounds,rupees]);
  assert.equal(mixed.comparable,false);
  assert.deepEqual(mixed.currencies,['£','₹']);
  assert.equal(mixed.cheapest,null,'Must not choose a false cheapest across currencies');
  assert.equal(mixed.comparison.length,2,'Preserve both source records and their currency labels');
  assert.deepEqual(mixed.comparison.map(x=>x.currency),['£','₹']);
  assert.match(mixed.reason,/different currencies/);
  console.log('PASS: Real Chromium price extraction + comparison rejects mixed currencies, preserves evidence, invents no exchange rate');

  const less=await product('Book Two','£5.00','In stock');
  const same=buildProductPriceComparison([pounds,less]);
  assert.equal(same.comparable,true);
  assert.equal(same.cheapest.title,'Book Two');
  assert.equal(same.cheapest.numericPrice,5);
  assert.deepEqual(same.comparison.map(x=>x.numericPrice),[5,20]);
  console.log('PASS: Same-currency prices still sort numerically with correct cheapest');

  const high=await product('Expensive Book','£1,234.50','In stock');
  const grouping=buildProductPriceComparison([high,less]);
  assert.equal(grouping.comparable,true);
  assert.equal(grouping.comparison[1].numericPrice,1234.50);
  console.log('PASS: Grouped thousands and decimal pence are parsed without losing currency');

  const invalid=buildProductPriceComparison([pounds,{...rupees,price:'Unknown'}]);
  assert.equal(invalid.comparable,false);
  assert.equal(invalid.cheapest,null);
  console.log('PASS: Incomplete price evidence also fails closed');
} finally {await browser.close();}
