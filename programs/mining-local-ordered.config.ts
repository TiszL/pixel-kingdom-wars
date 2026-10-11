/** Explicit isolated DB/validator run; excluded from ordinary API tests. */
export default {test:{include:['../../programs/mining-local-ordered.fixture.ts'],fileParallelism:false,testTimeout:600_000,hookTimeout:60_000}};
