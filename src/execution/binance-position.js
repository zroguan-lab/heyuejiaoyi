function positive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

export function inferPositionMarginType(position = {}) {
  const explicit = String(position.marginType ?? "").toUpperCase();
  if (explicit === "ISOLATED") return "isolated";
  if (explicit === "CROSS" || explicit === "CROSSED") return "cross";
  if (position.isolated === true || String(position.isolated).toLowerCase() === "true") return "isolated";
  if (positive(position.isolatedMargin) || positive(position.isolatedWallet)) return "isolated";
  return "cross";
}
