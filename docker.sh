#!/bin/bash

docker build -t chat-gpt-api-free .
docker stop chat-gpt-api-free
docker rm chat-gpt-api-free
/**
容器名：chat-gpt-api-free
对外端口：851
*/
docker run -d -p 851:2048 --name chat-gpt-api-free chat-gpt-api-free


