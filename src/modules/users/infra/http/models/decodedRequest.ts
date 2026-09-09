
import express from 'express';
import { JWTClaims } from "../../../domain/jwt";

export interface DecodedExpressRequest extends express.Request {
  headers: express.Request['headers'];
  body: express.Request['body'];
  params: express.Request['params'];
  query: express.Request['query'];
  decoded: JWTClaims
}