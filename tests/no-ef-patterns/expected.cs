// NEGATIVE FIXTURE: Plain C# class with NO EF patterns
// Scanner should produce 0 counts for all EF metrics on this file

namespace MyApp.Services
{
    public class ProductService
    {
        private readonly IProductRepository _repo;

        public ProductService(IProductRepository repo)
        {
            _repo = repo;
        }

        public Product GetById(int id)
        {
            return _repo.GetById(id);
        }

        public void Save(Product product)
        {
            _repo.Save(product);
        }
    }

    public interface IProductRepository
    {
        Product GetById(int id);
        void Save(Product product);
    }

    public class Product
    {
        public int Id { get; set; }
        public string Name { get; set; }
        public decimal Price { get; set; }
    }
}
