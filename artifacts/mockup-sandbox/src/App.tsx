import { useState } from "react";

type Step = "form" | "pending" | "success" | "error";
type PaymentType = "mobile" | "card";

const OPERATORS = [
  { value: "mtn_open", label: "MTN Mobile Money", country: "BJ" },
  { value: "moov_open", label: "Moov Money", country: "BJ" },
];

function App() {
  const [step, setStep] = useState<Step>("form");
  const [paymentType, setPaymentType] = useState<PaymentType>("mobile");
  const [amount, setAmount] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [operator, setOperator] = useState(OPERATORS[0].value);
  const [errorMsg, setErrorMsg] = useState("");
  const [transactionId, setTransactionId] = useState<number | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg("");

    if (!amount || Number(amount) <= 0) {
      setErrorMsg("Merci d'entrer un montant valide.");
      return;
    }

    setStep("pending");

    try {
      if (paymentType === "mobile") {
        if (!phoneNumber) {
          setErrorMsg("Merci d'entrer un numéro de téléphone.");
          setStep("form");
          return;
        }
        const res = await fetch("/api/checkout/mobile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amount: Number(amount),
            phoneNumber,
            country: OPERATORS.find((o) => o.value === operator)?.country ?? "BJ",
            operator,
            description: "Paiement Chap Money",
          }),
        });
        const data = (await res.json()) as { transactionId?: number; error?: string };
        if (!res.ok || !data.transactionId) {
          throw new Error(data.error ?? "Erreur lors du paiement");
        }
        setTransactionId(data.transactionId);
        setStep("success");
      } else {
        const res = await fetch("/api/checkout/card", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            amount: Number(amount),
            description: "Paiement Chap Money",
          }),
        });
        const data = (await res.json()) as { transactionId?: number; paymentUrl?: string; error?: string };
        if (!res.ok || !data.paymentUrl) {
          throw new Error(data.error ?? "Erreur lors du paiement");
        }
        window.location.href = data.paymentUrl;
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Une erreur est survenue.");
      setStep("error");
    }
  }

  function reset() {
    setStep("form");
    setAmount("");
    setPhoneNumber("");
    setErrorMsg("");
    setTransactionId(null);
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
        <h1 className="text-xl font-semibold text-gray-900 mb-1">Chap Money</h1>
        <p className="text-sm text-gray-500 mb-6">Envoyez de l'argent en toute simplicité</p>

        {step === "success" ? (
          <div className="text-center py-6">
            <div className="text-3xl mb-3">✅</div>
            <p className="font-medium text-gray-900 mb-1">Demande envoyée</p>
            <p className="text-sm text-gray-500 mb-1">
              Validez la transaction sur votre téléphone via votre opérateur.
            </p>
            {transactionId && (
              <p className="text-xs text-gray-400 mb-4">Transaction #{transactionId}</p>
            )}
            <button
              onClick={reset}
              className="mt-4 w-full rounded-lg bg-gray-900 text-white py-2.5 text-sm font-medium"
            >
              Nouveau paiement
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPaymentType("mobile")}
                className={`flex-1 rounded-lg py-2 text-sm font-medium border ${
                  paymentType === "mobile"
                    ? "bg-gray-900 text-white border-gray-900"
                    : "bg-white text-gray-600 border-gray-200"
                }`}
              >
                Mobile Money
              </button>
              <button
                type="button"
                onClick={() => setPaymentType("card")}
                className={`flex-1 rounded-lg py-2 text-sm font-medium border ${
                  paymentType === "card"
                    ? "bg-gray-900 text-white border-gray-900"
                    : "bg-white text-gray-600 border-gray-200"
                }`}
              >
                Carte bancaire
              </button>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Montant (XOF)
              </label>
              <input
                type="number"
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="1000"
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
                required
              />
            </div>

            {paymentType === "mobile" && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Opérateur
                  </label>
                  <select
                    value={operator}
                    onChange={(e) => setOperator(e.target.value)}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
                  >
                    {OPERATORS.map((op) => (
                      <option key={op.value} value={op.value}>
                        {op.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Numéro de téléphone
                  </label>
                  <input
                    type="tel"
                    value={phoneNumber}
                    onChange={(e) => setPhoneNumber(e.target.value)}
                    placeholder="97000000"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
                    required
                  />
                </div>
              </>
            )}

            {errorMsg && (
              <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{errorMsg}</p>
            )}

            <button
              type="submit"
              disabled={step === "pending"}
              className="w-full rounded-lg bg-gray-900 text-white py-2.5 text-sm font-medium disabled:opacity-50"
            >
              {step === "pending" ? "Traitement..." : "Payer"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default App;
