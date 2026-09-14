export function checkOutcome(selectedCheckKeys, receipts) {
  const executedCheckKeys = receipts.map(receipt => receipt.key);
  const failedCheckKeys = receipts.filter(receipt => !receipt.passed).map(receipt => receipt.key);
  const notRunCheckKeys = selectedCheckKeys.filter(key => !executedCheckKeys.includes(key));
  return {
    state: 'finished', selectedCheckKeys, executedCheckKeys,
    passedCheckKeys: receipts.filter(receipt => receipt.passed).map(receipt => receipt.key),
    failedCheckKeys, notRunCheckKeys,
    stopReason: failedCheckKeys.length ? 'check_failed' : notRunCheckKeys.length ? 'incomplete_selection' : null,
  };
}
