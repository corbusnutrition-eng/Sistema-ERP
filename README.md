# Sistema de Facturacion (FastAPI)

Arquitectura base para una API de facturacion con FastAPI, SQLAlchemy y Pydantic.

## Instalar dependencias

```bash
pip install -r requirements.txt
```

## Ejecutar en desarrollo

```bash
uvicorn app.main:app --reload
```

## Endpoints base

- `GET /health`
- `GET /api/v1/invoices`
- `GET /api/v1/invoices/{invoice_id}`
- `POST /api/v1/invoices`
