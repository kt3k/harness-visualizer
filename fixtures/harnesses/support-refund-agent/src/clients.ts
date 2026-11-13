// SYNTHETIC FIXTURE — written for harness-visualizer; not production code.
import Anthropic from "@anthropic-ai/sdk";
import Stripe from "stripe";
import nodemailer from "nodemailer";
import { Pool } from "pg";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? "fixture-secret-DO-NOT-USE-0123456789abcdef";

export const llm = new Anthropic();
export const stripe = new Stripe(STRIPE_SECRET_KEY);
export const db = new Pool({ connectionString: process.env.DATABASE_URL });
export const mailer = nodemailer.createTransport({ host: "smtp.example.com", port: 587 });
