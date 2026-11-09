process.env.DATABASE_URL ??=
  'postgresql://dtp_user:dtp_password@localhost:5432/distributed_transaction_processing';
process.env.SQS_CONSUMER_ENABLED = 'false';
