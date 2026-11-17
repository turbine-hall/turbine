import { TurbineError } from '@turbine-hall/turbine-contracts';

export function printResult(data: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  if (typeof data === 'string') {
    process.stdout.write(`${data}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export function handleError(error: unknown): never {
  if (error instanceof TurbineError) {
    process.stderr.write(`[${error.code}] ${error.message}\n`);
    if (error.details) {
      process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    }
    process.exit(error.exitCode);
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}
