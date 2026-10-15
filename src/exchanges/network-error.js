export function networkErrorDetail(error) {
  const cause = error?.cause;
  const leaf = cause instanceof AggregateError ? cause.errors?.[0] ?? cause : cause;
  const address = leaf?.hostname ?? (leaf?.address ? `${leaf.address}${leaf.port ? `:${leaf.port}` : ""}` : null);
  return [leaf?.syscall, leaf?.code, address].filter(Boolean).join(" ")
    || leaf?.message
    || cause?.message
    || error?.message
    || String(error);
}
