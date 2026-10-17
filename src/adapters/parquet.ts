import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";

/** Reads the given columns of a local Parquet file. */
export async function readParquet(
  file: string,
  columns: string[],
): Promise<Array<Record<string, unknown>>> {
  return (await parquetReadObjects({
    file: await asyncBufferFromFile(file),
    columns,
  })) as Array<Record<string, unknown>>;
}
