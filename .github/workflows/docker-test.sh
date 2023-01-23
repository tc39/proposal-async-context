name: Docker Image CI

on:
  push:
    branches: [ "master" ]
  pull_request:
    branches: [ "master" ]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - uses: actions/checkout@v3
    - name: Run AsyncContext tests with benjamn/deno:async-context Docker image
      run: docker/tests/docker-run.sh benjamn/deno:async-context