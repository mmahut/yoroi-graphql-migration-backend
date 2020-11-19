export default {
  db: {
    user: "csyncdb",
    host: "dbsync1.mainnet.core.blockfrost.io",
    database: "csyncdb",
    password: "",
  },
  server: {
    addressRequestLimit: 50,
    apiResponseLimit: 50,
    graphqlEndpoint: "http://localhost:3100/",
    txSubmissionEndpoint: "https://backend.yoroiwallet.com/api/submit/tx",
    smashEndpoint: "https://smash.yoroiwallet.com/api/v1/metadata/",
    port: 8082,
    txsHashesRequestLimit: 150,
  },
};
